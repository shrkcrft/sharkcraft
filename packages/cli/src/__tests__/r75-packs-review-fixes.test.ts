/**
 * Round 11 packs-lane review fixes. Each verdict here used to print a clean
 * sentence (or exit 0) over something it had not verified, or over an error:
 *
 *   1. `templates doctor` said "Clean. ✓" over a change op `templates lint`
 *      rejects (`key`/`value` for `entryKey`/`entryValue`).
 *   2. `doctor` printed an ERR "Unregistered entry exports" check next to
 *      "Ready for AI-agent use. ✓" and exit 0.
 *   3. `packs doctor` said "OK ✓" over a compiled artifact with no build
 *      record — the doctor's own finding said NOT VERIFIED.
 *   4. `packs doctor` over 0 discovered packs said "OK ✓" (and --allow-empty
 *      was a no-op on that path).
 *   5. the newly settled verbs were not registered verdict verbs, so a piped
 *      exit 2 was invisible.
 *
 * Plus the low-severity ones: `passed` agrees with the settled exit, an
 * uninstalled SDK is a not-run typecheck (2) rather than pack errors,
 * `packs contributions --kind` filters load failures too, and `helper get`
 * never interpolates an absent description.
 *
 * Real registries only: every fixture is a mkdtemp workspace read through
 * inspectSharkcraft by the real command handlers.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ParsedArgs } from '../command-registry.ts';
import { doctorCommand } from '../commands/doctor.command.ts';
import { helperGetCommand } from '../commands/helper.command.ts';
import {
  packsContributionsCommand,
  packsDoctorCommand,
  packsReleaseCheckCommand,
} from '../commands/packs.command.ts';
import { packsTestCommand } from '../commands/packs-new.ts';
import { templatesLintCommand } from '../commands/template-quality.command.ts';
import { templatesDoctorCommand } from '../commands/templates.command.ts';
import { emitPipeExitSignal, isGateVerb } from '../exit-codes.ts';

const SLOW = 90_000;
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function write(root: string, rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

/** A consumer project: package.json + sharkcraft/sharkcraft.config.ts + the given files. */
function project(files: Record<string, string>, config = "export default { projectName: 'r75-prf' };\n"): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-prf-'));
  roots.push(root);
  write(root, 'package.json', JSON.stringify({ name: 'r75-prf', version: '0.0.0', type: 'module', private: true }));
  write(root, 'sharkcraft/sharkcraft.config.ts', config);
  for (const [rel, body] of Object.entries(files)) write(root, rel, body);
  return root;
}

function args(root: string, positional: string[], flags: Record<string, string | boolean> = {}): ParsedArgs {
  return {
    positional,
    flags: new Map<string, string | boolean>([['cwd', root], ...Object.entries(flags)]),
    multiFlags: new Map(),
  };
}

async function run(
  h: { run(a: ParsedArgs): Promise<number> | number },
  a: ParsedArgs,
): Promise<{ code: number; out: string }> {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let out = '';
  process.stdout.write = ((c: string | Uint8Array): boolean => {
    out += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((): boolean => true) as typeof process.stderr.write;
  try {
    return { code: await h.run(a), out };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

/** A sentence ending in a check mark — the clean line no non-zero exit may print. */
const CLEAN = /✓/;

// ── 1. templates doctor reads templates lint ────────────────────────────────

const KEY_VALUE_TEMPLATE = [
  'export default [{',
  "  id: 'reg.add', name: 'Register', description: 'register a thing', tags: [], scope: [], appliesWhen: [],",
  "  variables: [{ name: 'name', required: true }],",
  "  changes: ({ name }: any) => [{ targetPath: 'src/registry.ts', operation: { kind: 'insert-array-entry', arrayName: 'ALL', key: name, value: `'${name}'` } }],",
  '}];',
  '',
].join('\n');

describe('templates doctor', () => {
  test(
    'a change op templates lint rejects fails the doctor too — exit 1, invalid-operation named, no ✓',
    async () => {
      const root = project(
        { 'sharkcraft/templates.ts': KEY_VALUE_TEMPLATE, 'src/registry.ts': "export const ALL = ['a'];\n" },
        "export default { projectName: 'p32t', templateFiles: ['templates.ts'] };\n",
      );
      const lint = await run(templatesLintCommand, args(root, []));
      expect(lint.code).toBe(1);
      const text = await run(templatesDoctorCommand, args(root, []));
      expect(text.code).toBe(lint.code);
      expect(text.out).toContain('invalid-operation');
      expect(text.out).toContain('entryValue');
      expect(text.out).not.toMatch(CLEAN);
      const json = await run(templatesDoctorCommand, args(root, [], { json: true }));
      expect(json.code).toBe(1);
      const report = JSON.parse(json.out) as {
        exitCode: number;
        totals: { fail: number };
        entries: { templateId: string; status: string; issues: { code: string; severity: string }[] }[];
      };
      expect(report.exitCode).toBe(1);
      expect(report.totals.fail).toBe(1);
      expect(report.entries[0]!.status).toBe('fail');
      expect(report.entries[0]!.issues.some((i) => i.code === 'invalid-operation' && i.severity === 'error')).toBe(true);
    },
    SLOW,
  );

  test(
    'no template registered → 2 NOT VERIFIED (text ≡ json); --allow-empty → 0 with the acceptance printed',
    async () => {
      const root = project({});
      const text = await run(templatesDoctorCommand, args(root, []));
      expect(text.code).toBe(2);
      expect(text.out).toContain('NOT VERIFIED');
      expect(text.out).toContain('Pass --allow-empty');
      expect(text.out).not.toMatch(CLEAN);
      const json = await run(templatesDoctorCommand, args(root, [], { json: true }));
      expect(json.code).toBe(2);
      expect((JSON.parse(json.out) as { exitCode: number; verdict: string }).verdict).toBe('not-verified');
      const accepted = await run(templatesDoctorCommand, args(root, [], { 'allow-empty': true }));
      expect(accepted.code).toBe(0);
      expect(accepted.out).toContain('accepted by --allow-empty');
    },
    SLOW,
  );
});

// ── 2. doctor: an error check is a failed doctor ────────────────────────────

const kEntry = (name: string, id: string, title: string): string =>
  `export const ${name} = { id: '${id}', title: '${title}', type: 'knowledge', priority: 'medium', summary: 's', content: '${title} body', tags: [], scope: [] };\n`;

describe('doctor — unregistered entry exports', () => {
  test(
    'an unregistered group export → exit 1, JSON exitCode 1 / ready false / passed false, "Not ready yet"',
    async () => {
      const root = project(
        {
          'sharkcraft/knowledge/group-a.ts': kEntry('a1', 'a.one', 'A one') + kEntry('a2', 'a.two', 'A two'),
          'sharkcraft/knowledge/group-b.ts': kEntry('b1', 'b.one', 'B one'),
          'sharkcraft/knowledge/index.ts':
            "import { a1 } from './group-a.ts';\nimport { b1 } from './group-b.ts';\n\nexport default [a1, b1];\n",
        },
        "export default { projectName: 'p31', knowledgeFiles: ['knowledge/index.ts'] };\n",
      );
      const text = await run(doctorCommand, args(root, []));
      expect(text.out).toContain('Unregistered entry exports');
      expect(text.out).toContain('a.two');
      expect(text.code).toBe(1);
      expect(text.out).toContain('Not ready yet');
      expect(text.out).not.toContain('Ready for AI-agent use');
      const json = await run(doctorCommand, args(root, [], { json: true }));
      expect(json.code).toBe(1);
      const report = JSON.parse(json.out) as { exitCode: number; ready: boolean; passed: boolean };
      expect({ exitCode: report.exitCode, ready: report.ready, passed: report.passed }).toEqual({
        exitCode: 1,
        ready: false,
        passed: false,
      });
    },
    SLOW,
  );
});

// ── 3 + 4. packs doctor coverage ─────────────────────────────────────────────

const ruleEntry = (summary: string): string =>
  `export default [{ id: 'distpack.rule', title: 'Rule', type: 'rule', priority: 'high', summary: '${summary}', content: '${summary} content', tags: [], scope: [], appliesWhen: [] }];\n`;

/** The p33 shape: a pack serving dist/assets/rules.js built from src/assets/rules.ts, with the given build record. */
function compiledPack(record: 'none' | 'fresh-map'): string {
  const src = ruleEntry('NEW source');
  const pack = 'node_modules/@r11/distpack';
  return project({
    [`${pack}/package.json`]: JSON.stringify({
      name: '@r11/distpack',
      version: '0.0.1',
      type: 'module',
      sharkcraft: { manifest: './dist/sharkcraft.plugin.js' },
    }),
    [`${pack}/dist/sharkcraft.plugin.js`]:
      "export default { schema: 'sharkcraft.pack/v1', info: { name: '@r11/distpack', version: '0.0.1' }, contributions: { ruleFiles: ['./dist/assets/rules.js'] } };\n",
    [`${pack}/dist/assets/rules.js`]: record === 'fresh-map' ? src : ruleEntry('OLD compiled'),
    [`${pack}/src/assets/rules.ts`]: src,
    ...(record === 'fresh-map'
      ? {
          [`${pack}/dist/assets/rules.js.map`]: JSON.stringify({
            version: 3,
            sources: ['../../src/assets/rules.ts'],
            sourcesContent: [src],
            mappings: '',
          }),
        }
      : {}),
  });
}

describe('packs doctor — compiled artifacts with no build record', () => {
  test(
    'no source map, no signature → 2 NOT VERIFIED (text ≡ json, passed false); --strict / --release → 1',
    async () => {
      const root = compiledPack('none');
      const text = await run(packsDoctorCommand, args(root, []));
      expect(text.out).toContain('compiled-artifacts-unrecorded');
      expect(text.code).toBe(2);
      expect(text.out).toContain('NOT VERIFIED');
      expect(text.out).toContain('dist/assets/rules.js');
      expect(text.out).not.toMatch(CLEAN);
      const json = JSON.parse((await run(packsDoctorCommand, args(root, [], { json: true }))).out) as {
        exitCode: number;
        verdict: string;
        passed: boolean;
        shortfalls: string[];
      };
      expect({ exit: json.exitCode, verdict: json.verdict, passed: json.passed }).toEqual({
        exit: 2,
        verdict: 'not-verified',
        passed: false,
      });
      expect(json.shortfalls.some((s) => s.includes('compiled artifacts'))).toBe(true);
      for (const flag of ['strict', 'release']) {
        const r = await run(packsDoctorCommand, args(root, [], { [flag]: true, json: true }));
        expect({ flag, code: r.code }).toEqual({ flag, code: 1 });
        const issues = (JSON.parse(r.out) as { issues: { code: string; severity: string }[] }).issues;
        expect(issues.find((i) => i.code === 'compiled-artifacts-unrecorded')?.severity).toBe('error');
      }
    },
    SLOW,
  );

  test(
    'a source map whose sourcesContent matches the source → examined, 0 and the clean line',
    async () => {
      const root = compiledPack('fresh-map');
      const r = await run(packsDoctorCommand, args(root, []));
      expect(r.out).not.toContain('compiled-artifacts-');
      expect(r.code).toBe(0);
      expect(r.out).toContain('OK ✓');
    },
    SLOW,
  );
});

describe('packs doctor — zero discovered packs', () => {
  test(
    '0 packs → 2 NOT VERIFIED + the --allow-empty hint (json passed false); --allow-empty → 0 accepted',
    async () => {
      const root = project({});
      const text = await run(packsDoctorCommand, args(root, []));
      expect(text.code).toBe(2);
      expect(text.out).toContain('NOT VERIFIED');
      expect(text.out).toContain('0 packs to examine');
      expect(text.out).toContain('Pass --allow-empty');
      expect(text.out).not.toMatch(CLEAN);
      const json = JSON.parse((await run(packsDoctorCommand, args(root, [], { json: true }))).out) as {
        exitCode: number;
        passed: boolean;
      };
      expect({ exit: json.exitCode, passed: json.passed }).toEqual({ exit: 2, passed: false });
      const accepted = await run(packsDoctorCommand, args(root, [], { 'allow-empty': true }));
      expect(accepted.code).toBe(0);
      expect(accepted.out).toContain('accepted by --allow-empty');
    },
    SLOW,
  );
});

// ── 5. the verdict-verb registry ─────────────────────────────────────────────

describe('the newly settled verbs are registered verdict verbs', () => {
  test('each carries its exit on the machine channel (--exit-trailer) — a non-verdict verb gets nothing', () => {
    // The piped-stdout note is rationed to once per process, so the always-on
    // trailer is the per-verb probe: emitPipeExitSignal returns early for any
    // path that is not a registered verdict verb.
    for (const verb of ['packs doctor', 'packs release-check', 'packs signature-status', 'packs test', 'templates doctor']) {
      expect({ verb, gate: isGateVerb(verb) }).toEqual({ verb, gate: true });
      let written = '';
      emitPipeExitSignal(verb, 2, { piped: false, trailer: true, write: (s) => void (written += s) });
      expect({ verb, written }).toEqual({ verb, written: 'shrk-exit: 2\n' });
    }
    let other = '';
    emitPipeExitSignal('packs list', 2, { piped: false, trailer: true, write: (s) => void (other += s) });
    expect(other).toBe('');
  });
});

// ── low severity ─────────────────────────────────────────────────────────────

/** A standalone pack whose TS manifest imports the SDK — unresolvable from a tmp dir with no install. */
function sdkPack(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-sdk-'));
  roots.push(root);
  write(root, 'package.json', JSON.stringify({ name: '@r75/sdk', version: '0.0.1', type: 'module', sharkcraft: { manifest: './src/sharkcraft.plugin.ts' } }));
  write(
    root,
    'src/sharkcraft.plugin.ts',
    [
      "import type { ISharkCraftPackManifest } from '@shrkcrft/plugin-api';",
      '',
      'export default {',
      "  schema: 'sharkcraft.pack/v1',",
      "  info: { name: '@r75/sdk', version: '0.0.1' },",
      "  contributions: { knowledgeFiles: ['./src/assets/knowledge.ts'] },",
      '} satisfies ISharkCraftPackManifest;',
      '',
    ].join('\n'),
  );
  write(
    root,
    'src/assets/knowledge.ts',
    [
      "import type { IKnowledgeEntry } from '@shrkcrft/plugin-api';",
      '',
      "export default [{ id: 'k1', title: 'K', type: 'technical', priority: 'low', scope: [], tags: [], appliesWhen: [], content: 'c' }] satisfies IKnowledgeEntry[];",
      '',
    ].join('\n'),
  );
  return root;
}

describe('typecheck with the SDK not installed', () => {
  test(
    'packs test / release-check --typecheck → 2 not-run (SDK not installed), never pack typecheck errors',
    async () => {
      const root = sdkPack();
      const t = await run(packsTestCommand, args(root, ['.'], { typecheck: true, json: true }));
      const report = JSON.parse(t.out) as {
        exitCode: number;
        passed: boolean;
        issues: { code: string }[];
        typecheck: { ran: boolean; note?: string };
      };
      expect(report.typecheck.ran).toBe(false);
      expect(report.typecheck.note).toContain('SDK not installed');
      expect(report.issues.some((i) => i.code === 'typecheck-error')).toBe(false);
      expect({ code: t.code, exit: report.exitCode, passed: report.passed }).toEqual({ code: 2, exit: 2, passed: false });
      const rc = await run(packsReleaseCheckCommand, args(root, [root], { typecheck: true, json: true }));
      const rcReport = JSON.parse(rc.out) as { exitCode: number; passed: boolean; findings: { code: string }[] };
      expect(rcReport.findings.some((f) => f.code === 'typecheck-error')).toBe(false);
      expect({ code: rc.code, exit: rcReport.exitCode, passed: rcReport.passed }).toEqual({ code: 2, exit: 2, passed: false });
    },
    SLOW,
  );
});

/** The proj shape: one pack with a broken knowledge file, a broken helper file and a good convention file. */
function contributionsProject(): string {
  const pack = 'node_modules/@r11/pack';
  return project({
    [`${pack}/package.json`]: JSON.stringify({ name: '@r11/pack', version: '0.0.1', type: 'module', sharkcraft: { manifest: './manifest.json' } }),
    [`${pack}/manifest.json`]: JSON.stringify({
      schema: 'sharkcraft.pack/v1',
      info: { name: '@r11/pack', version: '0.0.1' },
      contributions: {
        knowledgeFiles: ['./src/knowledge.ts'],
        helperFiles: ['./src/helpers-broken.ts'],
        conventionFiles: ['./src/conventions.ts'],
      },
    }),
    [`${pack}/src/knowledge.ts`]:
      "export default [{ id: 'pack.broken', title: 'B', type: 'knowledge', priority: 'medium', summary: 's', content: 'c', tags: ['a' 'b'], scope: [] }];\n",
    [`${pack}/src/helpers-broken.ts`]:
      "export default [{ id: 'r11.broken-helper', title: 'Broken', description: 'd', variables: ['x' 'y'], safety: { outputKind: 'plan' } }];\n",
    [`${pack}/src/conventions.ts`]:
      "export default [{ id: 'r11.conv', title: 'Conv', kind: 'naming', severity: 'warning', rules: [{ id: 'r1', description: 'd' }] }];\n",
  });
}

describe('packs contributions --kind', () => {
  test(
    'load failures follow the --kind filter the exit already follows',
    async () => {
      const root = contributionsProject();
      type Inv = { exitCode: number; loadFailures: { kind: string }[] };
      const all = JSON.parse((await run(packsContributionsCommand, args(root, [], { json: true }))).out) as Inv;
      expect(all.loadFailures.length).toBeGreaterThanOrEqual(2);
      expect(all.exitCode).toBe(1);
      const conv = await run(packsContributionsCommand, args(root, [], { kind: 'convention', json: true }));
      const convInv = JSON.parse(conv.out) as Inv;
      expect(convInv.loadFailures).toEqual([]);
      expect({ code: conv.code, exit: convInv.exitCode }).toEqual({ code: 0, exit: 0 });
      const helper = JSON.parse((await run(packsContributionsCommand, args(root, [], { kind: 'helper', json: true }))).out) as Inv;
      expect(helper.loadFailures.length).toBeGreaterThan(0);
      expect(helper.loadFailures.every((f) => f.kind === 'helper')).toBe(true);
      expect(helper.exitCode).toBe(1);
    },
    SLOW,
  );
});

describe('helper get', () => {
  test(
    'a manual-checklist op with no description prints its checklist, never "undefined"',
    async () => {
      const pack = 'node_modules/@r11/hp';
      const root = project({
        'src/routes.ts': 'export {};\n',
        [`${pack}/package.json`]: JSON.stringify({ name: '@r11/hp', version: '0.0.1', type: 'module', sharkcraft: { manifest: './manifest.json' } }),
        [`${pack}/manifest.json`]: JSON.stringify({
          schema: 'sharkcraft.pack/v1',
          info: { name: '@r11/hp', version: '0.0.1' },
          contributions: { helperFiles: ['./src/helpers.ts'] },
        }),
        [`${pack}/src/helpers.ts`]: [
          'export default [{',
          "  id: 'r11.add-route', title: 'Add a route', description: 'Registers a new route in the router table.',",
          "  variables: [{ name: 'name', required: true, description: 'route name' }],",
          '  operations: [',
          "    { kind: 'append-line', targetPath: 'src/routes.ts', snippet: \"export const {{name}} = '{{name}}';\", description: 'append route' },",
          "    { kind: 'manual-checklist', checklist: ['wire {{name}} into the app'] },",
          '  ],',
          "  safety: { outputKind: 'plan', requiresHumanReview: true },",
          '}];',
          '',
        ].join('\n'),
      });
      const r = await run(helperGetCommand, args(root, ['r11.add-route']));
      expect(r.code).toBe(0);
      expect(r.out).toContain('manual-checklist — wire {{name}} into the app');
      expect(r.out).not.toContain('undefined');
    },
    SLOW,
  );
});
