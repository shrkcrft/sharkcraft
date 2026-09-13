/**
 * r76 — THE census, spawned from source: a contributed entry its loader
 * refuses is impossible to miss (round 12, 12.1 + ONE-CHANGE).
 *
 * The round-12 report: a pack entry missing a required field vanished — the
 * list printed the survivors, the self-config doctor said `errors 0`, `packs
 * list` printed a FILE count and `packs doctor` said `OK ✓`. One REAL pack
 * (fixtures/r76-census, copied under node_modules) contributes one INVALID
 * entry to EVERY loader-backed manifest slot, and every one of them must
 * appear on:
 *
 *   - its kind's list verb, where one exists — `⚠ … rejected from <file>:
 *     '<id>' …`, exit 0 (a list is no verdict; `--json` stdout stays parseable);
 *   - `self-config doctor` — its `<kind>-invalid` ERROR (exit 1);
 *   - `packs list` — `entryCounts[<kind>].rejected`, the REJECTED-ENTRIES mark;
 *   - `packs doctor` — `contribution-entries-rejected` for the file (exit 1);
 *   - `packs contributions` — the By-file row names it (exit 1);
 *   - `packs test --load` — `asset-entry-rejected`, from the same runtime
 *     loader (exit 1).
 *
 * Framework extractors load in @shrkcrft/framework-scanners (above the
 * inspector): its runtime loader refuses the same candidate at the same
 * position as the inspector's channel — one shared predicate.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadPackExtractors } from '@shrkcrft/framework-scanners';
import { collectKindRejections, ContributionKind, inspectSharkcraft } from '@shrkcrft/inspector';
import { CONTRIBUTION_FILE_KEYS } from '@shrkcrft/plugin-api';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts');
const FIXTURE = join(REPO_ROOT, 'packages/inspector/src/__tests__/fixtures/r76-census');
const TIMEOUT_MS = 900_000;
const PACK_DIR = 'node_modules/@r76/census';

interface ICensusSlot {
  readonly file: string;
  readonly kind: string;
  readonly code: string;
  readonly entryId: string | null;
  readonly field: string;
  readonly declared: number;
  readonly list: readonly string[] | null;
}

const CENSUS = JSON.parse(readFileSync(join(FIXTURE, 'census.json'), 'utf8')) as {
  readonly pack: string;
  readonly slots: Readonly<Record<string, ICensusSlot>>;
};
const SLOTS = Object.entries(CENSUS.slots);

interface IRun {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

let root = '';
const runs = new Map<string, IRun>();

function shrk(argv: readonly string[]): IRun {
  const res = spawnSync('bun', ['run', CLI_MAIN, '--no-hints', ...argv], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function run(argv: readonly string[]): IRun {
  const key = argv.join(' ');
  let r = runs.get(key);
  if (!r) {
    r = shrk(argv);
    runs.set(key, r);
  }
  return r;
}

function json<T>(argv: readonly string[]): T {
  const r = run(argv);
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    throw new Error(`\`shrk ${argv.join(' ')}\` did not print JSON (exit ${r.status}):\n${r.stdout.slice(0, 600)}\n${r.stderr.slice(0, 600)}`);
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'shrk-r76-census-cli-'));
  cpSync(join(FIXTURE, 'consumer'), root, { recursive: true });
  cpSync(join(FIXTURE, 'pack'), join(root, PACK_DIR), { recursive: true });
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('r76 census — every loader-backed slot, every surface', () => {
  test('the census covers EVERY contribution slot — none may leave the channel', () => {
    expect(SLOTS.map(([slot]) => slot).sort()).toEqual([...CONTRIBUTION_FILE_KEYS].sort());
  });

  test(
    "each slot's list verb names the rejected entry, and still exits 0",
    () => {
      for (const [slot, c] of SLOTS) {
        if (!c.list) continue;
        const r = run(c.list);
        expect({ slot, verb: c.list.join(' '), status: r.status }).toEqual({ slot, verb: c.list.join(' '), status: 0 });
        const line = r.stdout.split('\n').find((l) => l.includes(`rejected from ${PACK_DIR}/${c.file}`)) ?? '';
        expect({ slot, noted: line.startsWith('⚠ ') }).toEqual({ slot, noted: true });
        expect({ slot, id: c.entryId === null || line.includes(`'${c.entryId}'`), field: line.includes(`${c.field}:`) }).toEqual({
          slot,
          id: true,
          field: true,
        });
      }
      // The three verbs that crashed on an accepted-but-unusable entry (12.1d)
      // run to a list: the template without `tags` is listed.
      expect(run(['templates', 'list']).stdout).toContain('cz.t-ok');
    },
    TIMEOUT_MS,
  );

  test(
    '`--json` keeps stdout a parseable array; the note goes to stderr as one line',
    () => {
      const r = run(['conventions', 'list', '--json']);
      expect(r.status).toBe(0);
      const rows = JSON.parse(r.stdout) as { convention: { id: string } }[];
      expect(rows.map((x) => x.convention.id)).toEqual(['cz.cv-ok']);
      expect(r.stderr).toContain('note: 1 entry rejected by the loader from node_modules/@r76/census/conventions.ts');
    },
    TIMEOUT_MS,
  );

  test(
    'self-config doctor: every rejection is its `<kind>-invalid` ERROR, and the run exits 1',
    () => {
      const report = json<{ findings: { code: string; severity: string; file?: string }[]; exitCode: number }>([
        'self-config',
        'doctor',
        '--json',
      ]);
      expect(report.exitCode).toBe(1);
      expect(run(['self-config', 'doctor', '--json']).status).toBe(1);
      for (const [slot, c] of SLOTS) {
        const hit = report.findings.find((f) => f.code === c.code && (f.file ?? '').endsWith(`/${c.file}`));
        expect({ slot, code: c.code, severity: hit?.severity }).toEqual({ slot, code: c.code, severity: 'error' });
      }
    },
    TIMEOUT_MS,
  );

  test(
    'packs list: per-kind rejected counts and the REJECTED-ENTRIES mark',
    () => {
      const rows = json<{ packageName: string; entryCounts: Record<string, { rejected: number; accepted: number }> }[]>([
        'packs',
        'list',
        '--json',
      ]);
      const counts = rows.find((p) => p.packageName === CENSUS.pack)!.entryCounts;
      for (const [slot, c] of SLOTS) {
        expect({ slot, rejected: (counts[c.kind]?.rejected ?? 0) >= 1 }).toEqual({ slot, rejected: true });
      }
      const text = run(['packs', 'list']);
      expect(text.status).toBe(0);
      expect(text.stdout).toContain(`${CENSUS.pack}@0.0.1  REJECTED-ENTRIES`);
      expect(text.stdout).toMatch(/entries: {2}.*convention 1 accepted · 1 REJECTED/);
      // The classic file tokens stay; every other declared slot is appended.
      expect(text.stdout).toMatch(/files: {4}k=1 r=1 p=1 t=1 pl=1 d=1 .*convention=1/);
    },
    TIMEOUT_MS,
  );

  test(
    'packs doctor: contribution-entries-rejected for every slot file, and the run exits 1',
    () => {
      const report = json<{ issues: { code: string; message: string }[]; exitCode: number }>(['packs', 'doctor', '--json']);
      expect(report.exitCode).toBe(1);
      for (const [slot, c] of SLOTS) {
        const hit = report.issues.find((i) => i.code === 'contribution-entries-rejected' && i.message.startsWith(`${c.file} (`));
        expect({ slot, reported: hit !== undefined }).toEqual({ slot, reported: true });
      }
    },
    TIMEOUT_MS,
  );

  test(
    'packs contributions: the By-file row names every rejection; conservation holds; the run exits 1',
    () => {
      const out = json<{
        exitCode: number;
        report: {
          files: { file: string; declared: number; accepted: number; rejected: { entryId?: string; index: number; reasons: string[] }[] }[];
        };
      }>(['packs', 'contributions', '--json']);
      expect(out.exitCode).toBe(1);
      for (const [slot, c] of SLOTS) {
        const row = out.report.files.find((f) => f.file === `${PACK_DIR}/${c.file}`);
        expect({
          slot,
          declared: row?.declared,
          accepted: row?.accepted,
          rejected: row?.rejected.map((r) => [r.entryId ?? null, r.index]),
        }).toEqual({ slot, declared: c.declared, accepted: c.declared - 1, rejected: [[c.entryId, c.declared - 1]] });
      }
      const text = run(['packs', 'contributions']);
      expect(text.status).toBe(1);
      expect(text.stdout).toContain('By file (');
      expect(text.stdout).toContain(`✗ ${PACK_DIR}/conventions.ts  convention [${CENSUS.pack}]  2 declared · 1 accepted · 1 rejected`);
      expect(text.stdout).toContain("rejected      'cz.cv-bad' (default[1]) — severity:");
    },
    TIMEOUT_MS,
  );

  test(
    'packs test --load: every slot file carries an asset-entry-rejected from its runtime loader; exit 1',
    () => {
      const out = json<{ issues: { code: string; message: string }[]; exitCode: number; suggestions?: string[] }>([
        'packs',
        'test',
        PACK_DIR,
        '--load',
        '--json',
      ]);
      expect(out.exitCode).toBe(1);
      for (const [slot, c] of SLOTS) {
        const hit = out.issues.find((i) => i.code === 'asset-entry-rejected' && i.message.startsWith(`${c.file} `));
        expect({ slot, reported: hit !== undefined, field: hit?.message.includes(`${c.field}:`) }).toEqual({
          slot,
          reported: true,
          field: true,
        });
      }
      // No --typecheck: one build-time pointer per kind, naming the plugin-api type.
      expect((out.suggestions ?? []).some((s) => s.includes('satisfies IConvention[]'))).toBe(true);
    },
    TIMEOUT_MS,
  );

  test(
    'framework extractors: the runtime loader (framework-scanners) refuses the same candidate the channel does',
    async () => {
      const inspection = await inspectSharkcraft({ cwd: root });
      const runtime = await loadPackExtractors(inspection.packs, new Set(['nestjs', 'react']));
      const channel = await collectKindRejections(inspection, [ContributionKind.FrameworkExtractor]);
      expect(runtime.extractors.map((e) => e.framework)).toEqual(['cz-fx']);
      expect(runtime.rejected.map((r) => [r.entryId, r.index, r.exportName])).toEqual([['cz-fx-bad', 1, 'default']]);
      expect(channel.map((r) => [r.entryId, r.index, r.exportName])).toEqual([['cz-fx-bad', 1, 'default']]);
      expect(runtime.rejected[0]!.reasons).toEqual(channel[0]!.reasons);
    },
    TIMEOUT_MS,
  );

  test(
    'packs get --json: per-kind entryCounts carry every census kind\'s rejection, and `rejections` names them (round 12 review, T1)',
    () => {
      const out = json<{ entryCounts: Record<string, { rejected: number }>; rejections: { entryId?: string }[] }>([
        'packs',
        'get',
        CENSUS.pack,
        '--json',
      ]);
      expect(run(['packs', 'get', CENSUS.pack, '--json']).status).toBe(0);
      for (const [slot, c] of SLOTS) {
        expect({ slot, rejected: (out.entryCounts[c.kind]?.rejected ?? 0) >= 1 }).toEqual({ slot, rejected: true });
      }
      expect(out.rejections.length).toBe(SLOTS.length);
    },
    TIMEOUT_MS,
  );

  test(
    'scaffolds doctor --json: a refused pattern is an ERROR — exit 1, counted, and named (round 12 review, T2)',
    () => {
      const out = json<{ errors: number; exitCode: number; rejected: { entryId?: string; file: string }[] }>([
        'scaffolds',
        'doctor',
        '--json',
      ]);
      expect(run(['scaffolds', 'doctor', '--json']).status).toBe(1);
      expect(out.exitCode).toBe(1);
      expect(out.rejected.map((r) => r.entryId)).toEqual(['cz.sp-bad']);
      expect(out.rejected[0]!.file).toBe(`${PACK_DIR}/scaffold-patterns.ts`);
      expect(out.errors).toBeGreaterThanOrEqual(out.rejected.length);
    },
    TIMEOUT_MS,
  );
});

describe('helper list counts a FAILED FILE apart from a REJECTED ENTRY (round 12 review, T2)', () => {
  test(
    'one helper file that does not import + a sibling with one refused entry: "1 helper file(s) failed", and the ⚠ note names the entry',
    () => {
      const ws = mkdtempSync(join(tmpdir(), 'shrk-r76-helper-list-'));
      const write = (rel: string, body: string): void => {
        mkdirSync(dirname(join(ws, rel)), { recursive: true });
        writeFileSync(join(ws, rel), body);
      };
      try {
        write('package.json', JSON.stringify({ name: 'fx', version: '0.0.0' }));
        write('sharkcraft/sharkcraft.config.ts', "export default { projectName: 'fx' };\n");
        write('src/a.ts', 'export const a = 1;\n');
        const dir = 'node_modules/@r76/hl';
        write(`${dir}/package.json`, JSON.stringify({ name: '@r76/hl', version: '0.0.1', sharkcraft: { manifest: './manifest.json' } }));
        write(
          `${dir}/manifest.json`,
          JSON.stringify({
            schema: 'sharkcraft.pack/v1',
            info: { name: '@r76/hl', version: '0.0.1' },
            contributions: { helperFiles: ['./broken.ts', './helpers.ts'] },
          }),
        );
        write(`${dir}/broken.ts`, "throw new Error('r76 broken helper file');\nexport default [];\n");
        write(
          `${dir}/helpers.ts`,
          "export default [\n  { id: 'hl.ok', title: 'OK helper', description: 'h', variables: [], safety: { outputKind: 'checklist' }, manualChecklist: ['do it'] },\n  { id: 'hl.bad', title: 'Bad helper', description: 'h', variables: [], manualChecklist: ['do it'] },\n];\n",
        );
        const res = spawnSync('bun', ['run', CLI_MAIN, '--no-hints', 'helper', 'list'], {
          cwd: ws,
          stdio: ['ignore', 'pipe', 'pipe'],
          encoding: 'utf8',
        });
        expect(res.status).toBe(0);
        const stdout = res.stdout ?? '';
        expect(stdout).toContain('hl.ok');
        expect(stdout).toContain('1 helper file(s) failed to load or are missing');
        const note = stdout.split('\n').find((l) => l.includes(`rejected from ${dir}/helpers.ts`)) ?? '';
        expect(note.startsWith('⚠ 1 entry rejected')).toBe(true);
        expect(note).toContain("'hl.bad'");
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    },
    TIMEOUT_MS,
  );
});
