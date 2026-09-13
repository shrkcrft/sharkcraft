/**
 * r77 — the gate-plane `expectEmpty` marker at load (round 13, lane G;
 * DECISIONS §1, §2 "Parsing", §4 "Conflicts" and "Pack forward-compat").
 *
 * One entry form serves every gate-plane markable list — `string | { pattern,
 * expectEmpty: true, reason? }` — and core's one parser judges it everywhere:
 *
 *   - LOCAL config: the zod schema's refinement calls `unitListProblems`, so a
 *     malformed marker fails the load (exit 3) with the parser's own sentence;
 *   - a PACK element: the SAME schema at the pack-plane merge seam refuses it
 *     through the round-12 rejection channel — an ERRORED row, never a crash,
 *     never a silent drop;
 *   - the conflicts: `failOnEmpty: true` with every primary inclusion unit
 *     marked is refused; baselines `expectEmpty` + `failOnEmpty` stays refused;
 *     `expectEmpty` + `mode: 'ceiling'` stays legal;
 *   - `$use`: an extractor's markers ride with its `files`, a local `files`
 *     override replaces them;
 *   - the normalisers are idempotent and stamp pack provenance; the engines
 *     normalise at entry, so a hand-built object-form rule never crashes.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { normalizePlaneConfig, normalizePlaneRule } from '@shrkcrft/config';
import { evaluatePolicy, inspectSource, readGlobListUnits, runPolicyLint } from '@shrkcrft/boundaries';
import type { IPolicyRule, IWiringSource } from '@shrkcrft/core';

const REPO_ROOT = resolve(import.meta.dir, '../../../..');
const CLI_MAIN = join(REPO_ROOT, 'packages', 'cli', 'src', 'main.ts');
const PACK = '@r77/marker-pack';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function write(root: string, rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

/** A real workspace; `pack` installs a real pack under node_modules contributing `slot` → `file`. */
function fixture(files: Readonly<Record<string, string>>, pack?: { readonly slot: string; readonly file: string; readonly body: string }): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r77-marker-'));
  roots.push(root);
  write(root, 'package.json', JSON.stringify({ name: 'fx', version: '0.0.0' }));
  for (const [rel, body] of Object.entries(files)) write(root, rel, body);
  if (pack !== undefined) {
    const dir = `node_modules/${PACK}`;
    write(root, `${dir}/package.json`, JSON.stringify({ name: PACK, version: '0.0.1', sharkcraft: { manifest: './manifest.json' } }));
    write(
      root,
      `${dir}/manifest.json`,
      JSON.stringify({ schema: 'sharkcraft.pack/v1', info: { name: PACK, version: '0.0.1' }, contributions: { [pack.slot]: [`./${pack.file}`] } }),
    );
    write(root, `${dir}/${pack.file}`, pack.body);
  }
  return root;
}

function shrk(root: string, argv: readonly string[]): { readonly code: number; readonly out: string; readonly err: string } {
  const r = spawnSync('bun', [CLI_MAIN, '--no-hints', '--cwd', root, ...argv], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

const cfg = (planes: string): string => `export default { projectName: 'fx', ${planes} };\n`;
const policy = (files: string, extra = ''): string =>
  cfg(`policyRules: [{ id: 'p', surface: 'ts', pattern: 'react', message: 'm', files: ${files}${extra} }]`);

describe('local config — a malformed marker fails the load (exit 3) with the one parser\'s sentence', () => {
  const CASES: readonly (readonly [string, string, string])[] = [
    ["{ pattern: 'src/ui/**', expectEmpty: false }", 'files[0]: expectEmpty must be the literal true (got false) — write the plain string otherwise', 'policy files'],
    ["{ glob: 'src/ui/**', expectEmpty: true }", 'the unit is named `pattern` on every list', 'policy files'],
    ["{ pattern: 'src/ui/**', expectEmpty: true, reson: 'x' }", "unknown key 'reson'", 'policy files'],
    ['42', 'files[0]: must be a string or { pattern, expectEmpty: true, reason? } (got 42)', 'policy files'],
    ["'src/a/**', { pattern: 'src/ui/**', expectEmpty: true }, { pattern: 'src/ui/**', expectEmpty: true }", "'src/ui/**' is already marked expectEmpty at files[1] — mark a unit once", 'policy files'],
    ["{ pattern: '!', expectEmpty: true }", '"!" is not a glob (an empty negation)', 'policy files'],
  ];
  for (const [entry, message, where] of CASES) {
    test(
      `${where}: ${entry}`,
      () => {
        const root = fixture({ 'src/a/x.ts': 'export {};\n', 'sharkcraft/sharkcraft.config.ts': policy(`[${entry}]`) });
        const r = shrk(root, ['policy-lint']);
        expect(r.code).toBe(3);
        expect(`${r.out}${r.err}`).toContain(message);
      },
      60_000,
    );
  }

  test(
    'every markable gate-plane list refuses a malformed marker: source files, to.files, watchFiles, generatedGlob, doc files, extractors',
    () => {
      const bad = "{ pattern: 'x/**', expectEmpty: 'yes' }";
      const configs = [
        cfg(`wiringRules: [{ id: 'w', declared: { files: [${bad}], pattern: 'a(b)' }, registered: { files: ['src/r.ts'], pattern: 'a(b)' } }]`),
        cfg(`baselines: [{ id: 'b', baseline: 'b.json', compute: { kind: 'extractor', source: { files: ['a/**'], extract: 'import-edges', to: { files: [${bad}] } } } }]`),
        cfg(`baselines: [{ id: 'b', baseline: 'b.json', watchFiles: [${bad}], compute: { kind: 'extractor', source: { files: ['a/**'], extract: 'export-names' } } }]`),
        cfg(`generatedArtifacts: [{ id: 'g', generatedGlob: [${bad}], provenanceHeader: { mustMatch: 'G' } }]`),
        cfg(`docReferences: [{ id: 'd', files: [${bad}], tokenPattern: 'x', resolvesAs: ['command'] }]`),
        cfg(`extractors: { e: { files: [${bad}], pattern: 'a(b)' } }`),
      ];
      for (const config of configs) {
        const root = fixture({ 'sharkcraft/sharkcraft.config.ts': config });
        const r = shrk(root, ['gates', 'list']);
        expect({ config, code: r.code }).toEqual({ config, code: 3 });
        expect(`${r.out}${r.err}`).toContain('expectEmpty must be the literal true (got "yes")');
      }
    },
    60_000,
  );
});

describe('conflicts', () => {
  test(
    'failOnEmpty: true with EVERY primary inclusion unit marked is refused (3); partial marking loads',
    () => {
      const all = fixture({ 'sharkcraft/sharkcraft.config.ts': policy("[{ pattern: 'src/ui/**', expectEmpty: true }]", ', failOnEmpty: true') });
      const refused = shrk(all, ['policy-lint']);
      expect(refused.code).toBe(3);
      expect(`${refused.out}${refused.err}`).toContain('every inclusion unit of `files` is asserted empty (expectEmpty)');
      const partial = fixture({
        'src/a/x.ts': 'export {};\n',
        'sharkcraft/sharkcraft.config.ts': policy("['src/a/**', { pattern: 'src/ui/**', expectEmpty: true }]", ', failOnEmpty: true'),
      });
      expect(shrk(partial, ['policy-lint']).code).toBe(0);
    },
    60_000,
  );

  test(
    "baselines: expectEmpty + failOnEmpty stays refused; expectEmpty + mode: 'ceiling' stays legal",
    () => {
      const both = fixture({
        'sharkcraft/sharkcraft.config.ts': cfg(
          "baselines: [{ id: 'b', baseline: 'b.json', expectEmpty: true, failOnEmpty: true, compute: { kind: 'extractor', source: { files: ['a/**'], extract: 'export-names' } } }]",
        ),
      });
      expect(shrk(both, ['gates', 'list']).code).toBe(3);
      const ceiling = fixture({
        'sharkcraft/sharkcraft.config.ts': cfg(
          "baselines: [{ id: 'c', mode: 'ceiling', ceiling: 0, expectEmpty: true, compute: { kind: 'extractor', source: { files: ['a/**'], extract: 'export-names' } } }]",
        ),
      });
      expect(shrk(ceiling, ['gates', 'list']).code).toBe(0);
    },
    60_000,
  );
});

describe('a pack element with a malformed marker — refused through the round-12 channel, never a crash', () => {
  test(
    'gates check shows an ERRORED row (1) and packs contributions names the rejection (1)',
    () => {
      const root = fixture(
        { 'src/core/a.ts': 'export {};\n', 'sharkcraft/sharkcraft.config.ts': cfg('') },
        {
          slot: 'policyRuleFiles',
          file: 'policy.ts',
          body: "export default [{ id: 'pk-policy', surface: 'ts', pattern: 'react', message: 'm', files: [{ pattern: 'src/ui/**', expectEmpty: 1 }] }];\n",
        },
      );
      const check = shrk(root, ['gates', 'check', '--json']);
      expect(check.code).toBe(1);
      const body = JSON.parse(check.out) as { gate: { rules: { id: string; status: string; error?: string }[] } };
      const row = body.gate.rules.find((r) => r.id === 'pk-policy');
      expect(row?.status).toBe('error');
      expect(row?.error).toContain('failed validation at the pack-plane merge seam');
      expect(row?.error).toContain('expectEmpty must be the literal true (got 1)');
      const contributions = shrk(root, ['packs', 'contributions']);
      expect(contributions.code).toBe(1);
      expect(contributions.out).toContain('expectEmpty must be the literal true (got 1)');
    },
    60_000,
  );

  test(
    'a well-formed pack marker is adopted and STAMPED with the pack',
    () => {
      const root = fixture(
        { 'src/core/a.ts': 'export {};\n', 'sharkcraft/sharkcraft.config.ts': cfg('') },
        {
          slot: 'policyRuleFiles',
          file: 'policy.ts',
          body: "export default [{ id: 'pk-policy', surface: 'ts', pattern: 'react', message: 'm', files: ['src/core/**', { pattern: 'src/ui/**', expectEmpty: true }] }];\n",
        },
      );
      const cov = JSON.parse(shrk(root, ['gates', 'coverage', '--json']).out) as {
        rules: { id: string; units?: { intendedEmpty: readonly string[] } }[];
      };
      expect(cov.rules.find((r) => r.id === 'pk-policy')?.units?.intendedEmpty.join('\n')).toContain(`[marker from pack ${PACK}]`);
    },
    60_000,
  );
});

describe('$use — markers travel with the list they mark', () => {
  test(
    "a consumer inherits the extractor's markers; a local `files` override replaces them with its own",
    () => {
      const root = fixture({
        'src/h/a.ts': 'export const A_H = 1;\n',
        'sharkcraft/sharkcraft.config.ts': cfg(
          "extractors: { handlers: { files: ['src/h/*.ts', { pattern: 'src/h2/*.ts', expectEmpty: true }], pattern: 'export const ([A-Z]+)_H' } }, " +
            "registries: [{ name: 'inherits', source: { $use: 'handlers' } }, { name: 'overrides', source: { $use: 'handlers', files: ['src/h/*.ts', { pattern: 'src/h3/*.ts', expectEmpty: true }] } }]",
        ),
      });
      const cov = JSON.parse(shrk(root, ['gates', 'coverage', '--json']).out) as {
        rules: { id: string; units?: { intendedEmpty: readonly string[]; dead: readonly string[] } }[];
      };
      const inherits = cov.rules.find((r) => r.id === 'inherits')?.units?.intendedEmpty.join('\n') ?? '';
      const overrides = cov.rules.find((r) => r.id === 'overrides')?.units?.intendedEmpty.join('\n') ?? '';
      expect(inherits).toContain('src/h2/*.ts');
      expect(overrides).toContain('src/h3/*.ts');
      expect(overrides).not.toContain('src/h2/*.ts');
    },
    60_000,
  );
});

describe('normalisers and engine entries (in process, real functions)', () => {
  test('normalizePlaneRule: plain lists + the ledger; idempotent; packageName stamped only by the caller', () => {
    const authored = {
      id: 'p',
      surface: 'ts' as const,
      pattern: 'x',
      message: 'm',
      files: ['src/a/**', { pattern: 'src/ui/**', expectEmpty: true as const, reason: 'planned' }],
    };
    const once = normalizePlaneRule('policy', authored, '@fx/pack');
    expect(once.ok).toBe(true);
    if (!once.ok) return;
    const rule = once.value as unknown as IPolicyRule;
    expect(rule.files).toEqual(['src/a/**', 'src/ui/**']);
    expect(rule.expectEmptyUnits).toEqual([{ list: 'files', unit: 'src/ui/**', reason: 'planned', packageName: '@fx/pack' }]);
    const twice = normalizePlaneRule('policy', rule);
    expect(twice.ok && twice.value).toEqual(rule);
  });

  test('normalizePlaneConfig walks every plane and the extractors map', () => {
    const n = normalizePlaneConfig({
      extractors: { e: { files: ['a/**', { pattern: 'b/**', expectEmpty: true }], pattern: 'a(b)' } as unknown as IWiringSource },
      generatedArtifacts: [
        { id: 'g', generatedGlob: [{ pattern: 'gen/**', expectEmpty: true }] as unknown as string[], provenanceHeader: { mustMatch: 'G' } },
      ],
    });
    expect(n.ok).toBe(true);
    if (!n.ok) return;
    expect(n.value.extractors?.['e']?.files).toEqual(['a/**', 'b/**']);
    expect(n.value.extractors?.['e']?.expectEmptyUnits).toEqual([{ list: 'files', unit: 'b/**' }]);
    expect(n.value.generatedArtifacts?.[0]?.generatedGlob).toEqual(['gen/**']);
  });

  test('a hand-built object-form rule never crashes an engine: it is normalised at entry, and a malformed one is an error', () => {
    const root = fixture({ 'src/a/x.ts': 'const debugger_ = 1;\n', 'sharkcraft/sharkcraft.config.ts': cfg('') });
    const handBuilt = {
      id: 'hb',
      surface: 'ts',
      pattern: 'debugger',
      message: 'm',
      files: ['src/a/**', { pattern: 'src/ui/**', expectEmpty: true }],
    } as unknown as IPolicyRule;
    const report = runPolicyLint(root, [handBuilt]);
    expect(report.rules[0]?.status).toBe('failed');
    expect(report.rules[0]?.units?.intendedEmpty.join('\n')).toContain('src/ui/**');
    const malformed = { ...handBuilt, files: [{ pattern: 'src/ui/**', expectEmpty: 'yes' }] } as unknown as IPolicyRule;
    const bad = evaluatePolicy([malformed], () => []);
    expect(bad.rules[0]?.status).toBe('error');
    expect(bad.rules[0]?.error).toContain('expectEmpty must be the literal true');
    const inspected = inspectSource(root, { files: [{ pattern: 'src/a/**', expectEmpty: true }], pattern: '(debugger)' } as unknown as IWiringSource);
    expect(inspected.error).toBeUndefined();
    expect(inspected.filesScanned).toBe(1);
    const units = readGlobListUnits(root, [{ pattern: 'src/none/**', expectEmpty: 'no' }] as unknown as string[]);
    expect(units.dead[0]?.reason).toContain('expectEmpty must be the literal true');
  });
});
