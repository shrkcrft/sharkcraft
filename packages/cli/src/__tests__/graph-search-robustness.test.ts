import { describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runGraphCallers,
  runGraphIndex,
  runGraphSearch,
  runGraphStatus,
} from '../commands/graph-code-subverbs.ts';

/**
 * A workspace whose package exports `count` distinct functions that all share
 * the `sharkHandler` substring, so a fuzzy symbol search matches every one of
 * them — the setup needed to prove `total`/`truncated` stay honest past the cap.
 */
function manySymbolFixture(count: number): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-graph-search-rob-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo', workspaces: ['packages/*'] }, null, 2),
  );
  mkdirSync(join(root, 'packages', 'p', 'src'), { recursive: true });
  writeFileSync(
    join(root, 'packages', 'p', 'package.json'),
    JSON.stringify({ name: '@demo/p', main: 'src/h0.ts' }, null, 2),
  );
  for (let i = 0; i < count; i += 1) {
    writeFileSync(
      join(root, 'packages', 'p', 'src', `h${i}.ts`),
      `export function sharkHandler${i}() { return ${i}; }\n`,
    );
  }
  return root;
}

function makeArgs(positional: string[]): {
  positional: string[];
  flags: Map<string, string | boolean>;
  multiFlags: Map<string, string[]>;
} {
  const flags = new Map<string, string | boolean>();
  flags.set('json', true);
  return { positional, flags, multiFlags: new Map<string, string[]>() };
}

function withCwd<T extends { flags: Map<string, string | boolean> }>(args: T, cwd: string): T {
  args.flags.set('cwd', cwd);
  return args;
}

function capture(): { restore: () => string } {
  const orig = process.stdout.write.bind(process.stdout);
  let body = '';
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  return {
    restore() {
      process.stdout.write = orig;
      return body;
    },
  };
}

function captureStderr(): { restore: () => string } {
  const orig = process.stderr.write.bind(process.stderr);
  let body = '';
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  return {
    restore() {
      process.stderr.write = orig;
      return body;
    },
  };
}

async function index(root: string): Promise<void> {
  const cap = capture();
  await runGraphIndex(withCwd(makeArgs(['index']), root));
  cap.restore();
}

/** Append a malformed row to a nodes JSONL so the next load is corrupt. */
function corruptStore(root: string): void {
  const nodesDir = join(root, '.sharkcraft', 'graph', 'nodes');
  const jsonl = readdirSync(nodesDir).find((f) => f.endsWith('.jsonl'))!;
  appendFileSync(join(nodesDir, jsonl), '{ truncated row not valid json\n');
}

describe('graph search robustness (GR3 / C5)', () => {
  test('reports the TRUE pre-slice total + truncated when matches exceed --limit', async () => {
    const root = manySymbolFixture(8);
    try {
      await index(root);
      const args = withCwd(makeArgs(['search', 'sharkHandler']), root);
      args.flags.set('kind', 'symbol');
      args.flags.set('limit', '5');
      args.flags.set('no-refresh', true);
      const cap = capture();
      const code = await runGraphSearch(args);
      const json = JSON.parse(cap.restore());
      expect(code).toBe(0);
      // 8 symbols match but the page is capped at 5 — the metadata stays honest.
      expect(json.total).toBe(8);
      expect(json.total).toBeGreaterThan(5);
      expect(json.truncated).toBe(true);
      expect(json.matches.length).toBe(5);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a non-numeric --limit falls back to the default instead of zeroing results (NaN slice)', async () => {
    const root = manySymbolFixture(3);
    try {
      await index(root);
      const args = withCwd(makeArgs(['search', 'sharkHandler']), root);
      args.flags.set('kind', 'symbol');
      args.flags.set('limit', 'notanumber');
      args.flags.set('no-refresh', true);
      const cap = capture();
      const code = await runGraphSearch(args);
      const json = JSON.parse(cap.restore());
      expect(code).toBe(0);
      // Fallback limit (20) >= 3 matches → all returned, never an empty result.
      expect(json.matches.length).toBe(3);
      expect(json.total).toBe(3);
      expect(json.truncated).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('graph query verbs survive a corrupt store (E2)', () => {
  test('graph callers prints a rebuild hint, not a Fatal parse error', async () => {
    const root = manySymbolFixture(2);
    try {
      await index(root);
      corruptStore(root);
      const args = withCwd(makeArgs(['callers', 'sharkHandler0']), root);
      args.flags.set('no-refresh', true);
      const cap = capture();
      const code = await runGraphCallers(args);
      const out = cap.restore();
      expect(code).toBe(1);
      const json = JSON.parse(out);
      expect(json.state).toBe('corrupt');
      expect(json.nextCommand).toBe('shrk graph index');
      expect(out).not.toContain('Fatal');
      expect(out.toLowerCase()).toContain('corrupt');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('graph status reports corruption as a status line instead of crashing', async () => {
    const root = manySymbolFixture(2);
    try {
      await index(root);
      corruptStore(root);
      const cap = capture();
      const code = await runGraphStatus(withCwd(makeArgs(['status']), root));
      const out = cap.restore();
      expect(code).toBe(1);
      const json = JSON.parse(out);
      expect(json.state).toBe('corrupt');
      expect(out).not.toContain('Fatal');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('non-JSON corrupt output is a stderr rebuild hint, not a raw parse crash', async () => {
    const root = manySymbolFixture(2);
    try {
      await index(root);
      corruptStore(root);
      const args = withCwd(makeArgs(['status']), root);
      args.flags.delete('json');
      const errCap = captureStderr();
      const cap = capture();
      const code = await runGraphStatus(args);
      const out = cap.restore();
      const err = errCap.restore();
      expect(code).toBe(1);
      expect(err.toLowerCase()).toContain('corrupt');
      expect(err).not.toContain('Fatal');
      expect(out).not.toContain('Fatal');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
