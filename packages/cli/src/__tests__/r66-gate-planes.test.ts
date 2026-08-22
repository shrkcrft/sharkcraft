/**
 * CLI surfaces for the new planes: `shrk baseline`, `shrk generated {check,…}`,
 * `shrk gates`, and `shrk registry <name> duplicates`.
 *
 * The exit-code contract is the load-bearing part — an agent chains on `$?`,
 * so "checked nothing" (2) must never be reachable as a green 0, and `update`
 * must stay a separate, explicit verb from `check`.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  baselineCheckCommand,
  baselineListCommand,
  baselineUpdateCommand,
} from '../commands/baseline.command.ts';
import { generatedCheckCommand } from '../commands/generated.command.ts';
import { gatesCoverageCommand, gatesListCommand } from '../commands/gates.command.ts';
import { registryCommand } from '../commands/registry.command.ts';
import type { ParsedArgs } from '../command-registry.ts';

function args(root: string, positional: string[], flags: Record<string, string | boolean> = {}): ParsedArgs {
  return {
    positional,
    flags: new Map<string, string | boolean>([['cwd', root], ['json', true], ...Object.entries(flags)]),
    multiFlags: new Map(),
  };
}

function capture(): () => string {
  const orig = process.stdout.write.bind(process.stdout);
  let body = '';
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  return () => {
    process.stdout.write = orig;
    return body;
  };
}

/** A workspace whose config declares the given planes. */
function fixture(planes: string): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r66-'));
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0' }));
  writeFileSync(
    join(root, 'sharkcraft', 'sharkcraft.config.ts'),
    `export default { projectName: 'fx', ${planes} };\n`,
  );
  return root;
}

async function run(
  handler: { run(a: ParsedArgs): Promise<number> | number },
  a: ParsedArgs,
): Promise<{ code: number; out: string }> {
  const restore = capture();
  try {
    const code = await handler.run(a);
    return { code, out: restore() };
  } catch (e) {
    restore();
    throw e;
  }
}

describe('shrk baseline', () => {
  const PLANE = `baselines: [{
    id: 'ids',
    baseline: 'baselines/ids.json',
    compute: { kind: 'extractor', source: { files: ['src/**/*.ts'], extract: 'export-names' } },
  }]`;

  test('check refuses to pass when the committed baseline does not exist', async () => {
    const root = fixture(PLANE);
    try {
      writeFileSync(join(root, 'src', 'a.ts'), 'export const alpha = 1;\n');
      const { code, out } = await run(baselineCheckCommand, args(root, []));
      expect(code).toBe(1);
      expect(JSON.parse(out).results[0].error).toContain('does not exist');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('update writes the artifact and check then passes; a LOST entry fails', async () => {
    const root = fixture(PLANE);
    try {
      writeFileSync(join(root, 'src', 'a.ts'), 'export const alpha = 1;\nexport const beta = 2;\n');
      expect((await run(baselineUpdateCommand, args(root, []))).code).toBe(0);
      expect(existsSync(join(root, 'baselines', 'ids.json'))).toBe(true);
      expect(JSON.parse(readFileSync(join(root, 'baselines', 'ids.json'), 'utf8'))).toEqual(['alpha', 'beta']);

      expect((await run(baselineCheckCommand, args(root, []))).code).toBe(0);

      // Removing an export is a DELETION — the direction two-way exists for.
      writeFileSync(join(root, 'src', 'a.ts'), 'export const alpha = 1;\n');
      const after = await run(baselineCheckCommand, args(root, []));
      expect(after.code).toBe(1);
      expect(JSON.parse(after.out).results[0].diff.removed).toEqual(['beta']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('--dry-run reports what it would write without writing', async () => {
    const root = fixture(PLANE);
    try {
      writeFileSync(join(root, 'src', 'a.ts'), 'export const alpha = 1;\n');
      const { code, out } = await run(baselineUpdateCommand, args(root, [], { 'dry-run': true }));
      expect(code).toBe(0);
      expect(JSON.parse(out).dryRun).toBe(true);
      expect(existsSync(join(root, 'baselines', 'ids.json'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a compute that yields 0 entries against a NON-empty baseline is drift, not a skip', async () => {
    const root = fixture(PLANE);
    try {
      writeFileSync(join(root, 'src', 'a.ts'), 'export const alpha = 1;\n');
      expect((await run(baselineUpdateCommand, args(root, []))).code).toBe(0);
      // Emptying the source makes the recompute yield [] — everything vanished.
      writeFileSync(join(root, 'src', 'a.ts'), 'const notExported = 1;\n');
      const { code, out } = await run(baselineCheckCommand, args(root, []));
      expect(code).toBe(1);
      const result = JSON.parse(out).results[0];
      expect(result.status).toBe('failed');
      expect(result.diff.removed).toEqual(['alpha']);
      expect(result.emptyCompute).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('no baselines declared is NOT-VERIFIED (2), never a green 0', async () => {
    const root = fixture("projectName: 'fx'");
    try {
      expect((await run(baselineListCommand, args(root, []))).code).toBe(2);
      expect((await run(baselineCheckCommand, args(root, []))).code).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('shrk generated check', () => {
  const PLANE = `generatedArtifacts: [{
    id: 'g',
    generatedGlob: ['gen/**/*.ts'],
    provenanceHeader: { mustMatch: 'GENERATED .* do not edit', forbidOutside: true },
  }]`;

  test('flags a generated file with no header and a hand-written file wearing one', async () => {
    const root = fixture(PLANE);
    try {
      mkdirSync(join(root, 'gen'), { recursive: true });
      writeFileSync(join(root, 'gen', 'a.ts'), '// GENERATED by x — do not edit\nexport const a = 1;\n');
      writeFileSync(join(root, 'gen', 'b.ts'), 'export const b = 2;\n');
      writeFileSync(join(root, 'src', 'hand.ts'), '// GENERATED by x — do not edit\nexport const h = 3;\n');
      const { code, out } = await run(generatedCheckCommand, args(root, []));
      expect(code).toBe(1);
      const kinds = JSON.parse(out).results[0].provenance.map((p: { kind: string }) => p.kind).sort();
      expect(kinds).toEqual(['mislabeled', 'missing-header']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a glob matching 0 files fails by default at error severity (alpha.29)', async () => {
    // The default flipped in alpha.29: an `error`-severity rule that matches
    // nothing is a bug in the rule, so it FAILS rather than skipping.
    const root = fixture(PLANE);
    try {
      expect((await run(generatedCheckCommand, args(root, []))).code).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    const strict = fixture(PLANE.replace("id: 'g',", "id: 'g', failOnEmpty: true,"));
    try {
      expect((await run(generatedCheckCommand, args(strict, []))).code).toBe(1);
    } finally {
      rmSync(strict, { recursive: true, force: true });
    }
  });

  test('an explicit failOnEmpty:false keeps it a loud skip (2), never a green 0', async () => {
    const lenient = fixture(PLANE.replace("id: 'g',", "id: 'g', failOnEmpty: false,"));
    try {
      expect((await run(generatedCheckCommand, args(lenient, []))).code).toBe(2);
    } finally {
      rmSync(lenient, { recursive: true, force: true });
    }
  });
});

describe('shrk gates', () => {
  const PLANE = `wiringRules: [{
    id: 'live',
    declared: { files: ['src/**/*.ts'], extract: 'export-names', match: 'Plugin$' },
    registered: { files: ['reg/**/*.ts'], extract: 'array-members', anchor: 'PLUGINS' },
  }, {
    id: 'stale',
    declared: { files: ['nowhere/**/*.ts'], extract: 'export-names' },
    registered: { files: ['reg/**/*.ts'], extract: 'array-members', anchor: 'PLUGINS' },
  }]`;

  function build(planes: string): string {
    const root = fixture(planes);
    mkdirSync(join(root, 'reg'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), 'export const aPlugin = 1;\n');
    writeFileSync(join(root, 'reg', 'r.ts'), 'export const PLUGINS = [aPlugin];\n');
    return root;
  }

  test('list enumerates every plane\'s rules', async () => {
    const root = build(PLANE);
    try {
      const { code, out } = await run(gatesListCommand, args(root, []));
      expect(code).toBe(0);
      expect(JSON.parse(out).rules.map((r: { id: string }) => r.id)).toEqual(['live', 'stale']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('coverage flags the rule that matched nothing (error severity → exit 1)', async () => {
    const root = build(PLANE);
    try {
      const { code, out } = await run(gatesCoverageCommand, args(root, []));
      // alpha.29: the stale rule is error-severity, so its zero match is a
      // hard failure rather than an unverified result.
      expect(code).toBe(1);
      const parsed = JSON.parse(out);
      expect(parsed.empty).toBe(1);
      expect(parsed.rules.find((r: { id: string }) => r.id === 'stale').status).toBe('empty');
      expect(parsed.rules.find((r: { id: string }) => r.id === 'live').status).toBe('ok');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a stale rule that opted out of failOnEmpty exits NOT-VERIFIED (2), not 0', async () => {
    const root = build(PLANE.replace("id: 'stale',", "id: 'stale', failOnEmpty: false,"));
    try {
      const { code, out } = await run(gatesCoverageCommand, args(root, []));
      expect(code).toBe(2);
      expect(JSON.parse(out).empty).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('failOnEmpty turns a stale selector into a hard failure', async () => {
    const root = build(PLANE.replace("id: 'stale',", "id: 'stale', failOnEmpty: true,"));
    try {
      expect((await run(gatesCoverageCommand, args(root, []))).code).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a broken selfTest expectation fails coverage even when the rule matched', async () => {
    const root = build(
      `wiringRules: [{
        id: 'live',
        declared: { files: ['src/**/*.ts'], extract: 'export-names', match: 'Plugin$' },
        registered: { files: ['reg/**/*.ts'], extract: 'array-members', anchor: 'PLUGINS' },
        selfTest: { expectIds: ['ghostPlugin'] },
      }]`,
    );
    try {
      const { code, out } = await run(gatesCoverageCommand, args(root, []));
      expect(code).toBe(1);
      expect(JSON.parse(out).rules[0].expectationFailures[0]).toContain('ghostPlugin');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('shrk registry <name> duplicates', () => {
  const PLANE = `registries: [{
    name: 'ids',
    source: { files: ['src/**/*.ts'], extract: 'call-args', anchor: 'define' },
  }]`;

  test('reports every declaration site of a doubly-claimed id (exit 1)', async () => {
    const root = fixture(PLANE);
    try {
      writeFileSync(join(root, 'src', 'a.ts'), "define('alpha');\n");
      writeFileSync(join(root, 'src', 'b.ts'), "define('alpha');\ndefine('beta');\n");
      const { code, out } = await run(registryCommand, args(root, ['ids', 'duplicates']));
      expect(code).toBe(1);
      const parsed = JSON.parse(out);
      expect(parsed.duplicates).toHaveLength(1);
      expect(parsed.duplicates[0].id).toBe('alpha');
      expect(parsed.duplicates[0].sites.map((s: { file: string }) => s.file)).toEqual(['src/a.ts', 'src/b.ts']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a registry that matched 0 ids is NOT-VERIFIED (2), not a clean 0', async () => {
    const root = fixture(PLANE);
    try {
      const { code } = await run(registryCommand, args(root, ['ids', 'duplicates']));
      expect(code).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
