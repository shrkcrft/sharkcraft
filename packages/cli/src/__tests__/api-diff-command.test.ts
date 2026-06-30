import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFullIndex } from '@shrkcrft/graph';
import { apiDiffCommand } from '../commands/api-diff.command.ts';
import type { ParsedArgs } from '../command-registry.ts';

/**
 * Exercises the `shrk api-diff` CONSUMER path end-to-end against a real
 * code-graph index built with `buildFullIndex` (no `--with-signatures`, so the
 * command takes the GraphStore snapshot route). The fixture package exports
 * three symbols (`shared`, `doomed`, `C`); removing one and re-indexing is the
 * canonical breaking change.
 */
function setupFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-api-diff-cmd-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo-root', workspaces: ['packages/*'] }),
  );
  mkdirSync(join(root, 'packages', 'alpha', 'src'), { recursive: true });
  writeFileSync(
    join(root, 'packages', 'alpha', 'package.json'),
    JSON.stringify({ name: '@demo/alpha', main: 'src/index.ts' }),
  );
  writeFileSync(
    join(root, 'packages', 'alpha', 'src', 'index.ts'),
    'export function shared() { return 1; }\nexport function doomed() { return 2; }\nexport const C = 3;\n',
  );
  buildFullIndex({ projectRoot: root });
  return root;
}

function makeArgs(
  positional: string[],
  cwd: string,
  flags: Record<string, string | boolean> = {},
  multi: Record<string, string[]> = {},
): ParsedArgs {
  const f = new Map<string, string | boolean>();
  f.set('cwd', cwd);
  for (const [k, v] of Object.entries(flags)) f.set(k, v);
  const m = new Map<string, string[]>();
  for (const [k, v] of Object.entries(multi)) m.set(k, v);
  return { positional, flags: f, multiFlags: m };
}

/** Run a command while discarding its console output (used for setup steps). */
async function runQuiet(args: ParsedArgs): Promise<number> {
  const cap = capture();
  try {
    return await apiDiffCommand.run(args);
  } finally {
    cap.restore();
  }
}

function capture(): { restore: () => { out: string; err: string } } {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let out = '';
  let err = '';
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    out += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    err += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  return {
    restore() {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
      return { out, err };
    },
  };
}

describe('shrk api-diff command', () => {
  test('no subcommand → exit 2 and prints usage to stderr', async () => {
    const cap = capture();
    const code = await apiDiffCommand.run(makeArgs([], process.cwd()));
    const { out, err } = cap.restore();
    expect(code).toBe(2);
    expect(err).toContain('shrk api-diff capture');
    // Usage went to stderr, not stdout.
    expect(out).toBe('');
  });

  test('capture --output writes a baseline IApiSurface and exits 0 (--json shape)', async () => {
    const root = setupFixture();
    const outFile = join(root, 'baseline.json');
    try {
      const cap = capture();
      const code = await apiDiffCommand.run(
        makeArgs(['capture'], root, { json: true, output: outFile }),
      );
      const { out } = cap.restore();
      expect(code).toBe(0);
      // --json shape: { ok, wrote, total }.
      const reported = JSON.parse(out);
      expect(reported.ok).toBe(true);
      expect(reported.wrote).toBe(outFile);
      expect(reported.total).toBe(3);
      // The file on disk is a valid surface snapshot.
      expect(existsSync(outFile)).toBe(true);
      const surface = JSON.parse(readFileSync(outFile, 'utf8'));
      expect(surface.schema).toBe('sharkcraft.api-surface/v1');
      expect(surface.total).toBe(3);
      const names = (surface.symbols as Array<{ name: string }>).map((s) => s.name).sort();
      expect(names).toEqual(['C', 'doomed', 'shared']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('capture without --output → exit 2', async () => {
    const root = setupFixture();
    try {
      const cap = capture();
      const code = await apiDiffCommand.run(makeArgs(['capture'], root));
      const { err } = cap.restore();
      expect(code).toBe(2);
      expect(err).toContain('--output');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('diff against a baseline of the SAME surface reports no changes, exit 0', async () => {
    const root = setupFixture();
    const outFile = join(root, 'baseline.json');
    try {
      // Capture a baseline of the current surface.
      await runQuiet(makeArgs(['capture'], root, { output: outFile }));
      // Diff the (unchanged) current surface against it.
      const cap = capture();
      const code = await apiDiffCommand.run(makeArgs([outFile], root, { json: true }));
      const { out } = cap.restore();
      expect(code).toBe(0);
      const diff = JSON.parse(out);
      expect(diff.schema).toBe('sharkcraft.api-surface-diff/v1');
      expect(diff.baselineTotal).toBe(3);
      expect(diff.currentTotal).toBe(3);
      expect(diff.added).toBe(0);
      expect(diff.removed).toBe(0);
      expect(diff.changed).toBe(0);
      expect(diff.breakingCount).toBe(0);
      expect(diff.entries).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('removing an export with --fail-on-breaking → non-zero exit + breaking severity', async () => {
    const root = setupFixture();
    const outFile = join(root, 'baseline.json');
    try {
      // 1. Capture the baseline (3 exports).
      await runQuiet(makeArgs(['capture'], root, { output: outFile }));
      // 2. Remove the `doomed` export and re-index.
      writeFileSync(
        join(root, 'packages', 'alpha', 'src', 'index.ts'),
        'export function shared() { return 1; }\nexport const C = 3;\n',
      );
      buildFullIndex({ projectRoot: root });
      // 3. Diff with --fail-on-breaking.
      const cap = capture();
      const code = await apiDiffCommand.run(
        makeArgs([outFile], root, { json: true, 'fail-on-breaking': true }),
      );
      const { out } = cap.restore();
      expect(code).not.toBe(0);
      const diff = JSON.parse(out);
      expect(diff.baselineTotal).toBe(3);
      expect(diff.currentTotal).toBe(2);
      expect(diff.removed).toBe(1);
      expect(diff.breakingCount).toBeGreaterThanOrEqual(1);
      const removedEntry = (
        diff.entries as Array<{ kind: string; severity: string; symbol: { name: string } }>
      ).find((e) => e.kind === 'removed');
      expect(removedEntry).toBeDefined();
      expect(removedEntry!.severity).toBe('breaking');
      expect(removedEntry!.symbol.name).toBe('doomed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the same breaking removal WITHOUT --fail-on-breaking still exits 0', async () => {
    const root = setupFixture();
    const outFile = join(root, 'baseline.json');
    try {
      await runQuiet(makeArgs(['capture'], root, { output: outFile }));
      writeFileSync(
        join(root, 'packages', 'alpha', 'src', 'index.ts'),
        'export function shared() { return 1; }\nexport const C = 3;\n',
      );
      buildFullIndex({ projectRoot: root });
      const cap = capture();
      const code = await apiDiffCommand.run(makeArgs([outFile], root, { json: true }));
      const { out } = cap.restore();
      // Breaking change present, but the flag is what gates the exit code.
      expect(code).toBe(0);
      expect(JSON.parse(out).breakingCount).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an unreadable baseline path → exit 2', async () => {
    const root = setupFixture();
    try {
      const cap = capture();
      const code = await apiDiffCommand.run(
        makeArgs([join(root, 'does-not-exist.json')], root, { json: true }),
      );
      const { err } = cap.restore();
      expect(code).toBe(2);
      expect(err).toContain('Baseline read error');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
