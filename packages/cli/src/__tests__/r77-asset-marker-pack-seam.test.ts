/**
 * r77 — the pack seam for intended-empty ASSET units (round 13, lane A;
 * DECISIONS §4 pack forward-compat, JUDGES J2 must-fix a; DESIGN-D1 test 8).
 *
 * A pack author writes pre-emptive entries by nature: a framework pack's hint
 * targets a file only adopting apps have. Through a REAL pack under a temp
 * consumer's node_modules and the CLI run from source:
 *
 *   - a pack contributing a marked registration hint / scaffold pattern /
 *     search-tuning boost is accepted by every pack surface, and the consumer's
 *     doctors ACCEPT the planned unit (printed; the marker names its pack);
 *   - a malformed marker is refused LOUDLY, with the SAME reason on `packs
 *     contributions`, `packs list`, `packs test --load` and the doctor (it used
 *     to crash with `glob.includes is not a function`, load as `[object Object]`,
 *     or clamp to 0);
 *   - a pack marker that went live is INFO and never fails the consumer, not
 *     even under `--fail-on-dead-units` (the consumer cannot edit it);
 *   - `packs contributions` covers search tuning exactly as `search tuning
 *     doctor` does (one probe authority): a contributed boost whose target
 *     registry is empty is unexamined on both.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const CLI_MAIN = resolve(import.meta.dir, '..', 'main.ts');
const TIMEOUT_MS = 120_000;
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function write(root: string, rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

function shrk(root: string, argv: readonly string[]): { readonly code: number; readonly out: string; readonly err: string } {
  const r = spawnSync('bun', [CLI_MAIN, '--cwd', root, '--no-hints', ...argv], {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

const knowledge = (ids: readonly string[]): string =>
  `export default [${ids
    .map((id) => `{ id: '${id}', title: '${id}', type: 'architecture', priority: 'high', tags: [], content: 'About ${id}.' }`)
    .join(', ')}];\n`;

/** A consumer with a pack `@fx/<name>` under node_modules contributing the given files. */
function consumer(name: string, packFiles: Readonly<Record<string, string>>, withKnowledge = true): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r77-seam-'));
  roots.push(root);
  const slots: Record<string, string[]> = {};
  for (const file of Object.keys(packFiles)) {
    const slot = file.startsWith('registration')
      ? 'registrationHintFiles'
      : file.startsWith('scaffold')
        ? 'scaffoldPatternFiles'
        : 'searchTuningFiles';
    (slots[slot] ??= []).push(`./${file}`);
  }
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx-consumer', version: '0.0.0' }),
    'sharkcraft/sharkcraft.config.ts': withKnowledge
      ? "export default { projectName: 'fx', knowledgeFiles: ['knowledge.ts'] };\n"
      : "export default { projectName: 'fx' };\n",
    ...(withKnowledge ? { 'sharkcraft/knowledge.ts': knowledge(['fx.other']) } : {}),
    [`node_modules/@fx/${name}/package.json`]: JSON.stringify({ name: `@fx/${name}`, version: '0.0.1', sharkcraft: { manifest: './manifest.json' } }),
    [`node_modules/@fx/${name}/manifest.json`]: JSON.stringify({
      schema: 'sharkcraft.pack/v1',
      info: { name: `@fx/${name}`, version: '0.0.1' },
      contributions: slots,
    }),
    ...Object.fromEntries(Object.entries(packFiles).map(([f, body]) => [`node_modules/@fx/${name}/${f}`, body])),
  };
  for (const [rel, body] of Object.entries(files)) write(root, rel, body);
  return root;
}

const PLANNED_PACK = {
  'registration-hints.ts':
    "export default [{ id: 'fx.routes', title: 'Routes', discovery: { targetGlobs: [{ pattern: 'src/app/**/app.routes.ts', expectEmpty: true, reason: 'only apps that adopt routing have one' }] }, operations: [{ kind: 'append', snippet: 'x' }] }];\n",
  'scaffold-patterns.ts':
    "export default [{ id: 'fx.route', title: 'Route', description: 'A route', templateId: 'fx.none', matchPaths: [{ pattern: 'src/app/routes/*.route.ts', expectEmpty: true }], variables: [], appliesWhen: ['infer-template'], confidence: 'high' }];\n",
  'search-tuning.ts':
    "export default [{ id: 'fx.routing', boostIds: { 'knowledge:fx.routing-guide': { weight: 2, expectEmpty: true } } }];\n",
};

interface IDoctorJson {
  readonly exitCode: number;
  readonly accepted: readonly string[];
  readonly deadUnits: readonly string[];
  readonly units: { readonly intendedEmpty: readonly string[]; readonly wentLive: readonly string[] };
}

const DOCTORS: readonly (readonly string[])[] = [
  ['registrations', 'doctor'],
  ['scaffolds', 'doctor'],
  ['search', 'tuning', 'doctor'],
];

describe('r77 pack seam — intended-empty asset units', () => {
  test(
    "a pack's pre-emptive entries are accepted on every pack surface, and the consumer's doctors accept them (printed, stamped)",
    () => {
      const root = consumer('planned', PLANNED_PACK);
      const contributions = shrk(root, ['packs', 'contributions', '--json']);
      expect(contributions.code).toBe(0);
      const packRows = (JSON.parse(contributions.out) as {
        report: { files: { file: string; packageName?: string; accepted: number; rejected: unknown[] }[] };
      }).report.files.filter((f) => f.packageName === '@fx/planned');
      expect(packRows.map((f) => ({ file: f.file.split('/').pop(), accepted: f.accepted, rejected: f.rejected.length })).sort((a, b) => String(a.file).localeCompare(String(b.file)))).toEqual([
        { file: 'registration-hints.ts', accepted: 1, rejected: 0 },
        { file: 'scaffold-patterns.ts', accepted: 1, rejected: 0 },
        { file: 'search-tuning.ts', accepted: 1, rejected: 0 },
      ]);
      expect(shrk(root, ['packs', 'test', 'node_modules/@fx/planned', '--load']).code).toBe(0);
      for (const doctor of DOCTORS) {
        const r = shrk(root, [...doctor, '--json']);
        const body = JSON.parse(r.out) as IDoctorJson;
        expect({ doctor: doctor.join(' '), code: r.code, dead: body.deadUnits }).toEqual({ doctor: doctor.join(' '), code: 0, dead: [] });
        expect(body.accepted.join('\n')).toContain('accepted by expectEmpty');
        expect(body.units.intendedEmpty.join('\n')).toContain('[marker from pack @fx/planned]');
      }

      // The adopting app creates every target: each pack marker went live — INFO,
      // never a failure, even under --fail-on-dead-units.
      write(root, 'src/app/main/app.routes.ts', 'export {};\n');
      write(root, 'src/app/routes/home.route.ts', 'export {};\n');
      write(root, 'sharkcraft/knowledge.ts', knowledge(['fx.other', 'fx.routing-guide']));
      for (const doctor of DOCTORS) {
        const r = shrk(root, [...doctor, '--fail-on-dead-units', '--json']);
        const body = JSON.parse(r.out) as IDoctorJson;
        expect({ doctor: doctor.join(' '), code: r.code }).toEqual({ doctor: doctor.join(' '), code: 0 });
        expect(body.units.wentLive.join('\n')).toContain('reported as INFO, never fails');
      }
    },
    TIMEOUT_MS,
  );

  test(
    'a malformed marker in a pack reads the SAME on packs contributions, packs list, packs test --load and the doctor',
    () => {
      const root = consumer('broken', {
        'registration-hints.ts':
          "export default [{ id: 'fx.bad-hint', title: 'Bad', discovery: { targetGlobs: [{ glob: 'src/x/**', expectEmpty: true }] }, operations: [{ kind: 'append', snippet: 'x' }] }];\n",
        'scaffold-patterns.ts':
          "export default [{ id: 'fx.bad-pattern', title: 'Bad', description: 'd', templateId: 'fx.none', matchPaths: [{ pattern: 'src/x/**', expectEmpty: false }], variables: [], appliesWhen: ['infer-template'], confidence: 'high' }];\n",
        'search-tuning.ts': "export default [{ id: 'fx.bad-tuning', boostIds: { 'knowledge:fx.other': 'high' } }];\n",
      });
      const reasons = {
        hint: 'discovery.targetGlobs[0]: a marker naming no unit',
        pattern: 'matchPaths[0]: expectEmpty must be the literal true (got false)',
        tuning: 'boostIds["knowledge:fx.other"]: must be a number or { weight, expectEmpty: true, reason? } (got "high")',
      };
      const contributions = shrk(root, ['packs', 'contributions']);
      expect(contributions.code).toBe(1);
      const list = shrk(root, ['packs', 'list']);
      expect(list.out).toContain('REJECTED');
      const test = shrk(root, ['packs', 'test', 'node_modules/@fx/broken', '--load']);
      expect(test.code).toBe(1);
      for (const reason of Object.values(reasons)) {
        expect({ surface: 'packs contributions', reason, found: contributions.out.includes(reason) }).toEqual({
          surface: 'packs contributions',
          reason,
          found: true,
        });
        expect({ surface: 'packs test --load', reason, found: (test.out + test.err).includes(reason) }).toEqual({
          surface: 'packs test --load',
          reason,
          found: true,
        });
      }
      const hints = shrk(root, ['registrations', 'doctor', '--json']);
      expect(hints.code).toBe(1);
      expect(hints.out).toContain(reasons.hint);
      const patterns = shrk(root, ['scaffolds', 'doctor', '--json']);
      expect(patterns.code).toBe(1);
      expect(patterns.out).toContain(reasons.pattern);
      const tuning = shrk(root, ['search', 'tuning', 'doctor', '--json']);
      expect(tuning.code).toBe(1);
      expect(tuning.out).toContain(reasons.tuning.replaceAll('"', '\\"'));
    },
    TIMEOUT_MS,
  );

  test(
    'packs contributions covers search tuning exactly as search tuning doctor does: a boost into an empty registry is unexamined on both',
    () => {
      const root = consumer(
        'unverifiable',
        { 'search-tuning.ts': "export default [{ id: 'fx.boost', boostIds: { 'knowledge:fx.adopting-guide': 2 } }];\n" },
        false,
      );
      const doctor = shrk(root, ['search', 'tuning', 'doctor', '--json']);
      expect(doctor.code).toBe(2);
      expect((JSON.parse(doctor.out) as { shortfalls: string[] }).shortfalls.join('\n')).toContain('knowledge:fx.adopting-guide');
      const contributions = shrk(root, ['packs', 'contributions', '--json']);
      expect(contributions.code).toBe(2);
      const report = (JSON.parse(contributions.out) as {
        report: { files: { file: string; unresolvableReferences: { sourceId: string; field: string; kind: string; ids: string[]; reason: string }[] }[] };
      }).report;
      const tuningFile = report.files.find((f) => f.file.endsWith('search-tuning.ts'));
      expect(tuningFile?.unresolvableReferences).toEqual([
        { sourceId: 'fx.boost', field: 'boostIds', kind: 'knowledge', ids: ['fx.adopting-guide'], reason: 'registry-empty' },
      ]);
    },
    TIMEOUT_MS,
  );
});
