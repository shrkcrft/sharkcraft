/**
 * The alpha.29 gate contract: exit codes that match the banner, one JSON
 * envelope across planes, and a single `explain` entrypoint.
 *
 * The bug this file exists to prevent: a rule that enforced NOTHING was
 * reported honestly in text ("Not a full green") while `$?` said `0` — so an
 * agent chaining `shrk check wiring && next` marched straight past a stale
 * selector. Text honesty is not enough; the number has to agree.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkCommand } from '../commands/check.command.ts';
import { baselineCheckCommand, baselineExplainCommand } from '../commands/baseline.command.ts';
import { gatesCoverageCommand } from '../commands/gates.command.ts';
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
  const orig = process.stdout.write.bind(process.stdout);
  let body = '';
  process.stdout.write = ((c: string | Uint8Array): boolean => {
    body += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  return () => {
    process.stdout.write = orig;
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

/** A workspace with one PASSING wiring rule and one whose glob is stale. */
function fixture(planes: string): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r67-'));
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  mkdirSync(join(root, 'src', 'h'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0' }));
  writeFileSync(join(root, 'src', 'h', 'a.ts'), 'export const A_H = 1;\n');
  writeFileSync(join(root, 'src', 'reg.ts'), 'export const H = [A_H];\n');
  writeFileSync(join(root, 'sharkcraft', 'sharkcraft.config.ts'), `export default { projectName: 'fx', ${planes} };\n`);
  return root;
}

const LIVE = `{ id: 'live', declared: { files: ['src/h/*.ts'], extract: 'export-names', match: '_H$' }, registered: { files: ['src/reg.ts'], extract: 'array-members', anchor: 'H' } }`;
const STALE = `{ id: 'stale', declared: { files: ['nowhere/*.ts'], extract: 'export-names' }, registered: { files: ['src/reg.ts'], extract: 'array-members', anchor: 'H' } }`;

describe('C1 — a skipped rule is never masked by a passing sibling', () => {
  test('one passing rule + one stale error-rule FAILS (was a green 0)', async () => {
    const root = fixture(`wiringRules: [${LIVE}, ${STALE}]`);
    try {
      const { code } = await run(checkCommand, args(root, ['wiring']));
      expect(code).toBe(ExitCode.Failure);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('failOnEmpty defaults ON for error severity, OFF for warning', async () => {
    const warn = STALE.replace("id: 'stale',", "id: 'stale', severity: 'warning',");
    const root = fixture(`wiringRules: [${LIVE}, ${warn}]`);
    try {
      // A warning-severity stale rule is not a failure — but it is NOT a clean
      // pass either: something went unverified.
      const { code } = await run(checkCommand, args(root, ['wiring']));
      expect(code).toBe(ExitCode.NotVerified);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an explicit failOnEmpty:false opts a rule out of the new default', async () => {
    const opted = STALE.replace("id: 'stale',", "id: 'stale', failOnEmpty: false,");
    const root = fixture(`wiringRules: [${LIVE}, ${opted}]`);
    try {
      const { code } = await run(checkCommand, args(root, ['wiring']));
      expect(code).toBe(ExitCode.NotVerified);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('every rule evaluated and passing is still a clean 0', async () => {
    const root = fixture(`wiringRules: [${LIVE}]`);
    try {
      const { code } = await run(checkCommand, args(root, ['wiring']));
      expect(code).toBe(ExitCode.VerifiedPass);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('C2 — usage errors are exit 3, distinct from "nothing evaluated"', () => {
  test('an unknown rule id is a usage error, not a verdict', async () => {
    const root = fixture(`wiringRules: [${LIVE}]`);
    try {
      expect((await run(baselineExplainCommand, args(root, [], { id: 'nope' }))).code).toBe(ExitCode.UsageError);
      expect((await run(gatesCoverageCommand, args(root, [], { plane: 'bogus' }))).code).toBe(ExitCode.UsageError);
      expect((await run(registryCommand, args(root, ['nosuch', 'list']))).code).toBe(ExitCode.UsageError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('"no rules declared" stays 2 — nothing evaluated, not a bad request', async () => {
    const root = fixture(`wiringRules: [${LIVE}]`);
    try {
      expect((await run(baselineCheckCommand, args(root, [], { json: true }))).code).toBe(ExitCode.NotVerified);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('D1 — one JSON envelope across planes', () => {
  test('check wiring --json carries a `gate` envelope whose exit matches the code', async () => {
    const root = fixture(`wiringRules: [${LIVE}, ${STALE}]`);
    try {
      const { code, out } = await run(checkCommand, args(root, ['wiring'], { json: true }));
      const gate = JSON.parse(out).gate;
      expect(gate.schema).toBe('sharkcraft.gate/v1');
      expect(gate.verb).toBe('check wiring');
      expect(gate.exit).toBe(code);
      expect(gate.rules.map((r: { id: string }) => r.id).sort()).toEqual(['live', 'stale']);
      const stale = gate.rules.find((r: { id: string }) => r.id === 'stale');
      expect(stale.type).toBe('wiring');
      expect(stale.counts).toHaveProperty('declared');
      expect(stale.skipReason).toContain('0 files');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the per-plane payload is preserved alongside it (additive, not replacing)', async () => {
    const root = fixture(`wiringRules: [${LIVE}]`);
    try {
      const { out } = await run(checkCommand, args(root, ['wiring'], { json: true }));
      const payload = JSON.parse(out);
      expect(payload.schema).toBe('sharkcraft.wiring/v1');
      expect(Array.isArray(payload.rules)).toBe(true);
      expect(payload.rules[0]).toHaveProperty('ruleId'); // old shape intact
      expect(payload.gate.rules[0]).toHaveProperty('id'); // new shape alongside
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('A2 — baseline explain computes the `now` side before the first bless', () => {
  test('reports the live count, not 0, when no artifact exists yet', async () => {
    const root = fixture(
      `baselines: [{ id: 'b', baseline: 'baselines/b.json', compute: { kind: 'extractor', source: { files: ['src/h/*.ts'], extract: 'export-names', match: '_H$' } } }]`,
    );
    try {
      const { out } = await run(baselineExplainCommand, args(root, [], { id: 'b' }));
      expect(out).toContain('committed (none yet) → 1 now');
      expect(out).not.toContain('0 committed → 0 now');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('B1 — registry accepts both argument orders', () => {
  test('`registry <verb> <name>` resolves identically to `registry <name> <verb>`', async () => {
    const root = fixture(
      `registries: [{ name: 'ids', source: { files: ['src/h/*.ts'], extract: 'export-names', match: '_H$' } }]`,
    );
    try {
      const canonical = await run(registryCommand, args(root, ['ids', 'list'], { json: true }));
      const swapped = await run(registryCommand, args(root, ['list', 'ids'], { json: true }));
      expect(swapped.code).toBe(canonical.code);
      expect(JSON.parse(swapped.out).ids).toEqual(JSON.parse(canonical.out).ids);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
