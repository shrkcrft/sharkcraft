/**
 * Extraction-cache invalidation — the highest-severity correctness property in
 * the engine.
 *
 * The read memo exists so N rules sharing a glob cost one walk. If it ever
 * survived a file change, every gate would go green on stale data — the exact
 * failure the whole engine exists to prevent, now living inside the engine. A
 * bug here is a confident false green across every plane at once, so this file
 * asserts the full matrix: a file CHANGED, an id ADDED, an id REMOVED, a new
 * file ADDED, a matched file DELETED, and `--no-cache` parity.
 *
 * The assertions are at the VERDICT level, not the byte level: what matters is
 * that the gate's answer changes, not that some internal map did.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkCommand } from '../commands/check.command.ts';
import { gatesCoverageCommand } from '../commands/gates.command.ts';
import { baselineCheckCommand, baselineUpdateCommand } from '../commands/baseline.command.ts';
import { registryCommand } from '../commands/registry.command.ts';
import { ExitCode } from '../exit-codes.ts';
import type { ParsedArgs } from '../command-registry.ts';

function args(root: string, positional: string[], flags: Record<string, string | boolean> = {}): ParsedArgs {
  return {
    positional,
    flags: new Map<string, string | boolean>([['cwd', root], ...Object.entries(flags)]),
    multiFlags: new Map(),
  };
}

function capture(): () => string {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let body = '';
  const sink = ((c: string | Uint8Array): boolean => {
    body += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = sink;
  process.stderr.write = sink as typeof process.stderr.write;
  return () => {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    return body;
  };
}

async function run(h: { run(a: ParsedArgs): Promise<number> | number }, a: ParsedArgs) {
  const restore = capture();
  try {
    const code = await h.run(a);
    return { code, out: restore() };
  } catch (e) {
    restore();
    throw e;
  }
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'shrk-r70-'));
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  mkdirSync(join(root, 'src', 'h'), { recursive: true });
  mkdirSync(join(root, 'baselines'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0' }));
  writeFileSync(join(root, 'src/h/a.ts'), 'export const A_H = 1;\n');
  writeFileSync(join(root, 'src/registry.ts'), 'export const H = [A_H];\n');
  writeFileSync(
    join(root, 'sharkcraft', 'sharkcraft.config.ts'),
    `export default {
  extractors: {
    handlers: { files: ['src/h/*.ts'], extract: 'export-names', match: '_H$' },
  },
  wiringRules: [{
    id: 'wired',
    declared: { $use: 'handlers' },
    registered: { files: ['src/registry.ts'], extract: 'array-members', anchor: 'H' },
  }],
  registries: [{ name: 'handlers', source: { $use: 'handlers' } }],
  baselines: [{
    id: 'roster',
    baseline: 'baselines/roster.json',
    compute: { kind: 'extractor', source: { $use: 'handlers' } },
    direction: 'two-way',
  }],
};
`,
  );
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Ids the registry inventory currently reports. */
async function registryIds(flags: Record<string, string | boolean> = {}): Promise<string[]> {
  const { out } = await run(registryCommand, args(root, ['handlers', 'list'], { json: true, ...flags }));
  return (JSON.parse(out) as { ids: string[] }).ids;
}

describe('extraction cache — a change is ALWAYS seen', () => {
  test('an id ADDED to a matched file appears on the next run', async () => {
    expect(await registryIds()).toEqual(['A_H']);
    writeFileSync(join(root, 'src/h/a.ts'), 'export const A_H = 1;\nexport const B_H = 2;\n');
    expect(await registryIds()).toEqual(['A_H', 'B_H']);
  });

  test('an id REMOVED from a matched file disappears on the next run', async () => {
    writeFileSync(join(root, 'src/h/a.ts'), 'export const A_H = 1;\nexport const B_H = 2;\n');
    expect(await registryIds()).toEqual(['A_H', 'B_H']);
    writeFileSync(join(root, 'src/h/a.ts'), 'export const A_H = 1;\n');
    expect(await registryIds()).toEqual(['A_H']);
  });

  test('a NEW matched file is picked up', async () => {
    expect(await registryIds()).toEqual(['A_H']);
    writeFileSync(join(root, 'src/h/b.ts'), 'export const B_H = 2;\n');
    expect(await registryIds()).toEqual(['A_H', 'B_H']);
  });

  test('a DELETED matched file drops out', async () => {
    writeFileSync(join(root, 'src/h/b.ts'), 'export const B_H = 2;\n');
    expect(await registryIds()).toEqual(['A_H', 'B_H']);
    unlinkSync(join(root, 'src/h/b.ts'));
    expect(await registryIds()).toEqual(['A_H']);
  });

  test('--no-cache returns the IDENTICAL set — the cache is a speed choice, never a semantic one', async () => {
    writeFileSync(join(root, 'src/h/b.ts'), 'export const B_H = 2;\n');
    expect(await registryIds()).toEqual(await registryIds({ 'no-cache': true }));
    unlinkSync(join(root, 'src/h/b.ts'));
    expect(await registryIds()).toEqual(await registryIds({ 'no-cache': true }));
  });
});

describe('extraction cache — every plane sees the change, not just the registry', () => {
  test('the WIRING verdict flips when a new declared id appears', async () => {
    expect((await run(checkCommand, args(root, ['wiring']))).code).toBe(ExitCode.VerifiedPass);
    // B_H is declared but never added to the H array.
    writeFileSync(join(root, 'src/h/a.ts'), 'export const A_H = 1;\nexport const B_H = 2;\n');
    const after = await run(checkCommand, args(root, ['wiring']));
    expect(after.code).toBe(ExitCode.Failure);
    expect(after.out).toContain('B_H');
  });

  test('the BASELINE verdict flips when the computed set changes', async () => {
    expect((await run(baselineUpdateCommand, args(root, []))).code).toBe(ExitCode.VerifiedPass);
    expect((await run(baselineCheckCommand, args(root, []))).code).toBe(ExitCode.VerifiedPass);
    writeFileSync(join(root, 'src/h/a.ts'), 'export const A_H = 1;\nexport const B_H = 2;\n');
    const after = await run(baselineCheckCommand, args(root, []));
    expect(after.code).toBe(ExitCode.Failure);
    expect(after.out).toContain('B_H');
  });

  test('gates coverage counts the change, including through a SHARED extractor', async () => {
    const before = await run(gatesCoverageCommand, args(root, []));
    expect(before.out).toContain('1 ids');
    writeFileSync(join(root, 'src/h/a.ts'), 'export const A_H = 1;\nexport const B_H = 2;\n');
    const after = await run(gatesCoverageCommand, args(root, []));
    expect(after.out).toContain('2 ids');
    // The shared-extractor node must re-resolve too — it is the one place a
    // single stale read would mislead every consumer at once.
    expect(after.out).toContain('$use:handlers  —  2 ids');
  });
});
