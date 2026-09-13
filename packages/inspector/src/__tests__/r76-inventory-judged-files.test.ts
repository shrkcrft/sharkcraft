/**
 * r76 — the contributions inventory never regex-scrapes a file its loader
 * already READ (round 12 review, A-2), and the two cheap rejection-channel
 * fixes that ride on it (A-3, A-5).
 *
 * Real registries: mkdtemp consumers with a real sharkcraft config and real
 * packs under node_modules, read through inspectSharkcraft and THE async
 * inventory — the reviewer's repros, verbatim in shape:
 *
 *   - AR: a local scaffold-patterns.ts whose ONLY entry its loader refuses;
 *   - D2: two packs each declaring one refused scaffold pattern, same id;
 *   - K:  a knowledge module with a named `{ id, label }` helper array;
 *   - a boundary file with one invalid rule; two packs whose helper file fails
 *     to load, both scraping the same id.
 *
 * Asserted:
 *   - a fully-rejected file is judged by its loader: no regex id, no `totals`
 *     row, no header count — `extractionTotals.regexFallback === 0`;
 *   - two packs sharing one refused id raise no `duplicate-id-*` conflict, on
 *     the inventory AND the self-config doctor (which still reports each
 *     rejection as an ERROR);
 *   - an id scraped from a file that failed to load does not take effect, so
 *     it is never grouped into a duplicate — the load failure is the error;
 *   - a named `{ id, label }` helper array is no rejected entry; a named
 *     member meant as an entry still is (A-3);
 *   - a boundary rule rejection reads `(default[1])` like every other kind, at
 *     runtime and at build time (A-5).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { formatEntryRejection } from '../contribution-load-failures.ts';
import {
  buildPackContributionsInventoryAsync,
  ConflictKind,
  type IPackContributionsInventory,
} from '../pack-contributions-inventory.ts';
import { buildSelfConfigDoctorReportV2 } from '../self-config-doctor-v2.ts';
import { inspectSharkcraft, type ISharkcraftInspection } from '../sharkcraft-inspector.ts';
import { validateContributionFile } from '../validate-contribution-file.ts';

const TIMEOUT_MS = 180_000;
const roots: string[] = [];

/** A scaffold pattern with no `confidence` — its loader refuses it. */
const REFUSED_PATTERN = "export default [{ id: 'sp.x', title: 'x', templateId: 't', matchPaths: ['src/**'] }];\n";
/** A helper file that fails to import (a syntax error) — its `id:` is still regex-scrapable. */
const BROKEN_HELPERS =
  "export default [{ id: 'h.same', title: 'Same', description: 'd', variables: ['x' 'y'], safety: { outputKind: 'plan' } }];\n";

function consumer(
  local: Readonly<Record<string, string>>,
  packs: readonly { name: string; manifest: Record<string, readonly string[]>; files: Readonly<Record<string, string>> }[],
): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r76-judged-'));
  roots.push(root);
  const write = (rel: string, body: string): void => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  write('package.json', JSON.stringify({ name: 'fx', version: '0.0.0' }));
  write('sharkcraft/sharkcraft.config.ts', "export default { projectName: 'r76-judged' };\n");
  write('src/a.ts', 'export const a = 1;\n');
  for (const [rel, body] of Object.entries(local)) write(rel, body);
  for (const p of packs) {
    const dir = `node_modules/${p.name}`;
    write(`${dir}/package.json`, JSON.stringify({ name: p.name, version: '0.0.1', sharkcraft: { manifest: './manifest.json' } }));
    write(
      `${dir}/manifest.json`,
      JSON.stringify({ schema: 'sharkcraft.pack/v1', info: { name: p.name, version: '0.0.1' }, contributions: p.manifest }),
    );
    for (const [rel, body] of Object.entries(p.files)) write(`${dir}/${rel}`, body);
  }
  return root;
}

let rejectedRoot = '';
let rejected: ISharkcraftInspection;
let rejectedInv: IPackContributionsInventory;
let brokenInv: IPackContributionsInventory;

beforeAll(async () => {
  rejectedRoot = consumer(
    {
      // AR — a local file whose only entry is refused.
      'sharkcraft/scaffold-patterns.ts':
        "export default [{ id: 'sp.local', title: 'x', templateId: 't', matchPaths: ['src/**'] }];\n",
      // K — a valid default export, a named lookup array, and a named member meant as an entry.
      'sharkcraft/knowledge.ts': [
        "export const TAGS = [{ id: 'not-an-entry-meta', label: 'x' }];",
        "export const drafts = [{ id: 'rv.k-draft', title: 'Draft', type: 'technical' }];",
        "export default [{ id: 'rv.k-ok', title: 'K ok', type: 'technical', priority: 'low', scope: [], tags: [], appliesWhen: [], content: 'ok' }];",
        '',
      ].join('\n'),
    },
    [
      // D2 — two packs, one refused pattern each, the same id.
      {
        name: '@rv/a',
        manifest: { scaffoldPatternFiles: ['./scaffold-patterns.ts'], boundaryFiles: ['./boundaries.ts'] },
        files: {
          'scaffold-patterns.ts': REFUSED_PATTERN,
          'boundaries.ts':
            "export default [\n  { id: 'rv-bd-ok', title: 'ok', severity: 'warning', from: ['src/**'], forbiddenImports: ['lodash'] },\n  { id: 'rv-bd-bad', title: 'bad', forbiddenImports: ['lodash'] },\n];\n",
        },
      },
      { name: '@rv/b', manifest: { scaffoldPatternFiles: ['./scaffold-patterns.ts'] }, files: { 'scaffold-patterns.ts': REFUSED_PATTERN } },
    ],
  );
  rejected = await inspectSharkcraft({ cwd: rejectedRoot });
  rejectedInv = await buildPackContributionsInventoryAsync(rejected);

  const brokenRoot = consumer({}, [
    { name: '@rv/c', manifest: { helperFiles: ['./helpers.ts'] }, files: { 'helpers.ts': BROKEN_HELPERS } },
    { name: '@rv/d', manifest: { helperFiles: ['./helpers.ts'] }, files: { 'helpers.ts': BROKEN_HELPERS } },
  ]);
  brokenInv = await buildPackContributionsInventoryAsync(await inspectSharkcraft({ cwd: brokenRoot }));
}, TIMEOUT_MS);

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const isDuplicate = (kind: ConflictKind): boolean =>
  kind === ConflictKind.DuplicateIdSameKind || kind === ConflictKind.DuplicateIdDifferentSource;

describe('r76 the inventory never scrapes a file its loader already judged (A-2)', () => {
  test('a fully-rejected file: every refusal is in `rejections`, nothing is a contribution row', () => {
    const sp = rejectedInv.rejections.filter((r) => r.kind === 'scaffold-pattern');
    expect(sp.map((r) => `${r.packageName ?? 'local'}:${r.entryId}`).sort()).toEqual([
      '@rv/a:sp.x',
      '@rv/b:sp.x',
      'local:sp.local',
    ]);
    expect(rejectedInv.entries.filter((e) => e.kind === 'scaffold-pattern')).toEqual([]);
    expect(rejectedInv.totals['scaffold-pattern']).toBeUndefined();
    expect(rejectedInv.extractionTotals).toMatchObject({ regexFallback: 0, fileOnly: 0 });
  });

  test('two packs sharing one refused id raise no duplicate — on the inventory and the self-config doctor', async () => {
    expect(rejectedInv.conflicts.filter((c) => isDuplicate(c.kind))).toEqual([]);
    const report = await buildSelfConfigDoctorReportV2(rejected);
    expect(report.findings.filter((f) => f.code.includes('duplicate-id'))).toEqual([]);
    // Each refusal is still reported — as an ERROR, never dropped with the duplicate.
    expect(report.findings.filter((f) => f.sourceId === 'sp.x' && f.severity === 'error').length).toBeGreaterThan(0);
  });

  test('an id scraped from a file that failed to load is never grouped into a duplicate', () => {
    expect(brokenInv.loadFailures.map((f) => f.packageName).sort()).toEqual(['@rv/c', '@rv/d']);
    expect(brokenInv.conflicts.filter((c) => c.kind === ConflictKind.InvalidContribution)).toHaveLength(2);
    expect(brokenInv.conflicts.filter((c) => isDuplicate(c.kind))).toEqual([]);
    // Still listed — as scraped and NOT in effect, never `ok`.
    const scraped = brokenInv.entries.filter((e) => e.id === 'h.same');
    expect(scraped.length).toBe(2);
    expect(scraped.every((e) => e.validation === 'error')).toBe(true);
  });
});

describe('r76 the rejection channel: helper values and one wording (A-3, A-5)', () => {
  test("a named `{ id, label }` helper array is no rejected entry; a named member meant as an entry is", async () => {
    const knowledge = rejectedInv.rejections.filter((r) => r.kind === 'knowledge');
    expect(knowledge.map((r) => `${r.exportName}[${r.index}] ${r.entryId}`)).toEqual(['drafts[0] rv.k-draft']);
    const report = await buildSelfConfigDoctorReportV2(rejected);
    expect(report.findings.filter((f) => f.sourceId === 'not-an-entry-meta')).toEqual([]);
  });

  test('a boundary rule rejection reads `(default[1])` — at runtime and at build time', async () => {
    const bd = rejectedInv.rejections.find((r) => r.entryId === 'rv-bd-bad');
    expect(bd).toBeDefined();
    expect(formatEntryRejection(bd!)).toContain("'rv-bd-bad' (default[1]) — ");
    const v = await validateContributionFile('boundaryFiles', join(rejectedRoot, 'node_modules/@rv/a/boundaries.ts'));
    expect(v.rejected.map((r) => formatEntryRejection(r).split(' — ')[0])).toEqual(["'rv-bd-bad' (default[1])"]);
  });
});
