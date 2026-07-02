import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFullIndex } from '@shrkcrft/graph';
import {
  constructsTraceCommand,
  constructsImpactCommand,
  constructsFilesCommand,
} from '../commands/constructs.command.ts';

/**
 * A construct that DECLARES only 4 of the 10 `*_TOKEN` constants in its file,
 * and uses a glob for `files`. `constructs trace` must graph-verify: expand the
 * glob and surface the 6 undeclared symbols.
 */
function setupFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-constructs-trace-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo', workspaces: ['packages/*'] }, null, 2),
  );
  mkdirSync(join(root, 'packages', 'p', 'src'), { recursive: true });
  writeFileSync(
    join(root, 'packages', 'p', 'package.json'),
    JSON.stringify({ name: '@demo/p', main: 'src/index.ts' }, null, 2),
  );
  const tokens = Array.from({ length: 10 }, (_, i) => `export const FOO${i}_TOKEN = ${i};`);
  writeFileSync(join(root, 'packages', 'p', 'src', 'index.ts'), tokens.join('\n') + '\n');
  // Construct declares only the first 4 tokens, and a glob for files.
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  writeFileSync(
    join(root, 'sharkcraft', 'constructs.ts'),
    `export default [{
  id: 'demo.tokens',
  type: 'token-set',
  title: 'Demo tokens',
  files: ['packages/p/src/**/*.ts'],
  tokens: ['FOO0_TOKEN', 'FOO1_TOKEN', 'FOO2_TOKEN', 'FOO3_TOKEN'],
}];\n`,
  );
  return root;
}

function makeArgs(positional: string[], cwd: string, json = true) {
  const flags = new Map<string, string | boolean>();
  flags.set('cwd', cwd);
  if (json) flags.set('json', true);
  return { positional, flags, multiFlags: new Map<string, string[]>() };
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

/**
 * A construct declaring ONE glob that covers 6 real files. The declared list is
 * length 1 (would score risk='low'); the graph-resolved set is 6 (risk='medium').
 */
function setupMultiFileFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-constructs-multi-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo', workspaces: ['packages/*'] }, null, 2),
  );
  mkdirSync(join(root, 'packages', 'p', 'src'), { recursive: true });
  writeFileSync(
    join(root, 'packages', 'p', 'package.json'),
    JSON.stringify({ name: '@demo/p', main: 'src/index.ts' }, null, 2),
  );
  for (let i = 0; i < 6; i += 1) {
    writeFileSync(join(root, 'packages', 'p', 'src', `m${i}.ts`), `export const v${i} = ${i};\n`);
  }
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  writeFileSync(
    join(root, 'sharkcraft', 'constructs.ts'),
    `export default [{
  id: 'demo.svc',
  type: 'service',
  title: 'Demo service',
  files: ['packages/p/src/**/*.ts'],
}];\n`,
  );
  return root;
}

describe('constructs impact / files — graph-resolved file set', () => {
  test('impact risk + file count reflect the EXPANDED glob (not the 1 declared entry)', async () => {
    const root = setupMultiFileFixture();
    try {
      buildFullIndex({ projectRoot: root });
      const cap = capture();
      await constructsImpactCommand.run(makeArgs(['demo.svc'], root));
      const json = JSON.parse(cap.restore());
      expect(json.files.length).toBe(6);
      expect(json.files).toContain('packages/p/src/m0.ts');
      expect(json.files).not.toContain('packages/p/src/**/*.ts');
      // 6 files > 4 → medium (the declared length-1 glob would have been 'low').
      expect(json.risk).toBe('medium');
      expect(json.humanReviewRequired).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('files subverb emits resolved paths, not the raw glob', async () => {
    const root = setupMultiFileFixture();
    try {
      buildFullIndex({ projectRoot: root });
      const cap = capture();
      await constructsFilesCommand.run(makeArgs(['demo.svc'], root));
      const json = JSON.parse(cap.restore());
      expect(json.files.length).toBe(6);
      expect(json.files).not.toContain('packages/p/src/**/*.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('without a graph index, impact falls back to the declared list (offline determinism)', async () => {
    const root = setupMultiFileFixture();
    try {
      const cap = capture();
      await constructsImpactCommand.run(makeArgs(['demo.svc'], root));
      const json = JSON.parse(cap.restore());
      // No index: declared glob is the only entry → length 1, risk low.
      expect(json.files).toEqual(['packages/p/src/**/*.ts']);
      expect(json.risk).toBe('low');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('constructs trace — graph-backed verification', () => {
  test('expands file globs and surfaces undeclared symbols', async () => {
    const root = setupFixture();
    try {
      buildFullIndex({ projectRoot: root });
      const cap = capture();
      const code = await constructsTraceCommand.run(makeArgs(['demo.tokens'], root));
      const json = JSON.parse(cap.restore());
      expect(code).toBe(0);
      expect(json.graph.graphState).toBe('fresh');
      // Glob `packages/p/src/**/*.ts` resolves to the real file.
      expect(json.graph.resolvedFiles).toContain('packages/p/src/index.ts');
      expect(json.graph.unresolvedGlobs).toEqual([]);
      // The 6 tokens NOT declared on the construct are surfaced.
      for (const i of [4, 5, 6, 7, 8, 9]) {
        expect(json.graph.undeclaredSymbols).toContain(`FOO${i}_TOKEN`);
      }
      // The 4 declared tokens are NOT flagged as undeclared.
      for (const i of [0, 1, 2, 3]) {
        expect(json.graph.undeclaredSymbols).not.toContain(`FOO${i}_TOKEN`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('trace effectiveFiles expands the declared glob to real files', async () => {
    const root = setupFixture();
    try {
      buildFullIndex({ projectRoot: root });
      const cap = capture();
      await constructsTraceCommand.run(makeArgs(['demo.tokens'], root));
      const json = JSON.parse(cap.restore());
      // effectiveFiles is the resolved set, not the raw declared glob.
      expect(json.effectiveFiles).toContain('packages/p/src/index.ts');
      expect(json.effectiveFiles).not.toContain('packages/p/src/**/*.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('labels the inventory as declared-only when no graph store exists', async () => {
    const root = setupFixture();
    try {
      // Do NOT build the graph index.
      const cap = capture();
      const code = await constructsTraceCommand.run(makeArgs(['demo.tokens'], root));
      const json = JSON.parse(cap.restore());
      expect(code).toBe(0);
      expect(json.graph.graphState).toBe('missing');
      expect(json.graph.resolvedFiles).toEqual([]);
      expect(json.graph.undeclaredSymbols).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a raw code symbol (not a construct id) redirects — never phrased as "not found"', async () => {
    const root = setupFixture();
    try {
      buildFullIndex({ projectRoot: root });
      const cap = capture();
      // FOO0_TOKEN is a real exported symbol but NOT a registered construct id.
      const code = await constructsTraceCommand.run(makeArgs(['FOO0_TOKEN'], root));
      const json = JSON.parse(cap.restore());
      expect(code).toBe(1);
      expect(json.found).toBe(false);
      expect(json.reason).toBe('not-a-construct-id');
      expect(json.isCodeSymbol).toBe(true);
      expect(json.hint).toContain('graph callers');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an id that is neither construct nor code symbol says so without a false symbol claim', async () => {
    const root = setupFixture();
    try {
      buildFullIndex({ projectRoot: root });
      const cap = capture();
      const code = await constructsTraceCommand.run(makeArgs(['zzz-not-real'], root));
      const json = JSON.parse(cap.restore());
      expect(code).toBe(1);
      expect(json.found).toBe(false);
      expect(json.isCodeSymbol).toBe(false);
      expect(json.hint).toContain('constructs list');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
