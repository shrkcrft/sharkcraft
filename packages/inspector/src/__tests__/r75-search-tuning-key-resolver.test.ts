/**
 * r75 — search-tuning boost keys resolve through ONE codec and ONE resolver
 * (spec 1.6 / 3.5#2 / 1.6#3).
 *
 * The self-config doctor looked the WHOLE `<kind>:<id>` boost key up in
 * bare-id registries. Every correctly prefixed key (which fires) was reported
 * "unknown" and every bare key (which never fires) passed — 200 false warnings
 * on a healthy pack, inviting the deletion of correct config, while shrk's own
 * 33 dead entries were certified. The properties below make the doctor and the
 * matcher agree in BOTH directions, on real registries only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspectSharkcraft, type ISharkcraftInspection } from '../sharkcraft-inspector.ts';
import { buildSelfConfigDoctorReportV2 } from '../self-config-doctor-v2.ts';
import { warmReferenceRegistries } from '../reference-registry.ts';
import { buildSearchIndex } from '../search-index.ts';
import {
  isSearchDocumentPrefix,
  parseSearchDocumentId,
  SEARCH_DOCUMENT_ID_KINDS,
  searchDocumentId,
  searchDocumentPrefixForReferenceKind,
} from '../search-document-id.ts';
import type { ReferenceKind } from '../reference-registry.ts';
import { lintSearchTuning } from '../search-tuning-lint.ts';
import { resolveSearchTuningKey } from '../search-tuning-key-resolver.ts';
import { SearchTuningKeyStatus } from '../search-tuning-key-status.ts';
import { loadSearchTuning, tuningBoostFor } from '../search-tuning-registry.ts';
import { explainSearchTuning } from '../search-tuning-explain.ts';
import { tuningQueryTokens } from '../tuning-query-tokens.ts';

const REPO = new URL('../../../..', import.meta.url).pathname.replace(/\/$/, '');
const TIMEOUT_MS = 120_000;
const roots: string[] = [];
/** Lint codes that say "this KEY never fires". */
const KEY_CODES: ReadonlySet<string> = new Set([
  'target-missing',
  'key-unprefixed',
  'key-unknown-kind',
  'boost-excluded-by-kind',
]);

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-tuningkey-'));
  roots.push(root);
  const all: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
    'sharkcraft/sharkcraft.config.ts': `export default { projectName: 'fx', knowledgeFiles: ['knowledge.ts'], ruleFiles: ['rules.ts'] };\n`,
    'sharkcraft/knowledge.ts': `export default [
  { id: 'alpha.entry', title: 'Alpha entry', type: 'architecture', priority: 'high', tags: ['alpha'], content: 'Alpha content about widgets and gizmos.' },
  { id: 'beta.entry', title: 'Beta entry', type: 'architecture', priority: 'medium', tags: ['beta'], content: 'Beta content about widgets.' },
  { id: 'gamma.entry', title: 'Gamma entry', type: 'architecture', priority: 'low', tags: ['captag'], content: 'Gamma content about widgets.' },
];
`,
    'sharkcraft/rules.ts': `export default [{ id: 'fixture.no-foo', title: 'No foo widgets', type: 'rule', priority: 'high', scope: [], tags: ['widgets'], appliesWhen: [], content: 'Never use foo widgets anywhere.' }];\n`,
    ...files,
  };
  for (const [rel, body] of Object.entries(all)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

/** The plan's fixture: prefixed keys (fire), a bare key (dead), a missing target, a misspelled prefix, a repeat. */
const TUNING = `export default [
  {
    id: 't.prefixed',
    boostIds: { 'knowledge:alpha.entry': 3 },
    taskHints: [
      { whenTokens: ['alpha'], boostIds: { 'knowledge:beta.entry': 4 } },
      { whenTokens: ['widgets'], boostIds: { 'knowledge:beta.entry': 2 } },
      { whenTokens: ['beta'], boostIds: { 'knowledge:beta.entry': 1 } },
    ],
  },
  { id: 't.bare', boostIds: { 'gamma.entry': 3 } },
  { id: 't.missing', boostIds: { 'knowledge:does.not.exist': 2 } },
  { id: 't.rule', boostIds: { 'rule:fixture.no-foo': 2 } },
  { id: 't.badprefix', boostIds: { 'knowlege:alpha.entry': 2 } },
  { id: 't.preset', boostIds: { 'preset:whatever': 1 } },
];
`;

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe('the codec', () => {
  test('splits on the FIRST colon, so a facet id round-trips', () => {
    expect(parseSearchDocumentId('facet:my.construct:event:x')).toEqual({ prefix: 'facet', id: 'my.construct:event:x' });
    expect(parseSearchDocumentId(searchDocumentId('knowledge', 'a.b'))).toEqual({ prefix: 'knowledge', id: 'a.b' });
    expect(parseSearchDocumentId('bare.id')).toBeNull();
    expect(parseSearchDocumentId(':x')).toBeNull();
  });
});

describe('phantoms, on a real fixture', () => {
  let insp: ISharkcraftInspection;
  beforeAll(async () => {
    insp = await inspectSharkcraft({ cwd: workspace({ 'sharkcraft/search-tuning.ts': TUNING }) });
    await warmReferenceRegistries(insp);
  }, TIMEOUT_MS);

  test('missing / unknown-kind / unprefixed / unverified are each told apart', () => {
    expect(resolveSearchTuningKey(insp, 'knowledge:alpha.entry').status).toBe(SearchTuningKeyStatus.Resolved);
    expect(resolveSearchTuningKey(insp, 'rule:fixture.no-foo').status).toBe(SearchTuningKeyStatus.Resolved);
    expect(resolveSearchTuningKey(insp, 'knowledge:zz.phantom').status).toBe(SearchTuningKeyStatus.Missing);
    const typo = resolveSearchTuningKey(insp, 'knowlege:alpha.entry');
    expect(typo.status).toBe(SearchTuningKeyStatus.UnknownKind);
    expect(typo.suggestion).toBe('knowledge:alpha.entry');
    const bare = resolveSearchTuningKey(insp, 'alpha.entry');
    expect(bare.status).toBe(SearchTuningKeyStatus.Unprefixed);
    expect(bare.suggestion).toBe('knowledge:alpha.entry');
    // No id registry for presets: NOT verified — never "missing".
    expect(resolveSearchTuningKey(insp, 'preset:x').status).toBe(SearchTuningKeyStatus.Unverified);
  });

  test('doctor ≡ matcher, both directions', async () => {
    const { entries } = await loadSearchTuning(insp);
    const keys = new Set<string>();
    const tokens = new Set<string>();
    for (const e of entries) {
      for (const m of [e.boostIds, ...(e.taskHints ?? []).map((h) => h.boostIds)]) {
        for (const k of Object.keys(m ?? {})) keys.add(k);
      }
      for (const h of e.taskHints ?? []) for (const t of h.whenTokens ?? []) tokens.add(t);
    }
    // Which keys does the MATCHER apply to some indexed document?
    const applied = new Set<string>();
    for (const doc of buildSearchIndex(insp)) {
      const boost = tuningBoostFor(
        { id: doc.id, kind: doc.kind, ...(doc.tags ? { tags: doc.tags } : {}), source: doc.source },
        [...tokens],
        entries,
      );
      for (const c of boost.composition ?? []) {
        if (c.key === `id:${doc.id}` || c.key === `task-hint:id:${doc.id}`) applied.add(doc.id);
      }
    }
    // The keys THE lint (the doctor's source — see r75-search-tuning-lint)
    // reports as never firing.
    const flagged = new Set(
      (await lintSearchTuning(insp)).issues.filter((i) => i.key && KEY_CODES.has(i.code)).map((i) => i.key!),
    );
    for (const key of keys) {
      const r = resolveSearchTuningKey(insp, key);
      if (applied.has(key)) {
        // Fires → never reported.
        expect({ key, flagged: flagged.has(key) }).toEqual({ key, flagged: false });
        expect(r.status).toBe(SearchTuningKeyStatus.Resolved);
      }
      if (
        r.status === SearchTuningKeyStatus.Unprefixed ||
        r.status === SearchTuningKeyStatus.Missing ||
        r.status === SearchTuningKeyStatus.UnknownKind
      ) {
        // Reported dead → the matcher applies it to nothing.
        expect({ key, applied: applied.has(key) }).toEqual({ key, applied: false });
        expect(flagged.has(key)).toBe(true);
      }
    }
    expect(applied.size).toBeGreaterThan(0);
  });

  test('the exact findings: 1 missing, 1 unprefixed (with the prefixed fix), 1 unknown kind; preset unverified', async () => {
    const report = await buildSelfConfigDoctorReportV2(insp);
    const tuning = report.findings.filter((f) => f.code.startsWith('search-tuning-') && f.severity === 'warning');
    expect(tuning.map((f) => [f.code, f.sourceId, f.targetId]).sort()).toEqual(
      [
        // An unknown kind names the KEY: its right-hand id resolves nowhere yet.
        ['search-tuning-key-unknown-kind', 't.badprefix', 'knowlege:alpha.entry'],
        ['search-tuning-key-unprefixed', 't.bare', 'gamma.entry'],
        ['search-tuning-target-missing', 't.missing', 'does.not.exist'],
      ].sort(),
    );
    const bare = tuning.find((f) => f.code === 'search-tuning-key-unprefixed')!;
    expect(bare.suggestedFix).toContain('knowledge:gamma.entry');
    expect(report.probes['search-tuning-target']).toEqual({
      probed: 7,
      resolved: 3,
      missing: 1,
      unprefixed: 1,
      unknownKind: 1,
      unverified: 1,
    });
    // Dead + unverifiable keys are coverage, so the verdict cannot be a pass.
    expect(report.verdict).toBe('unverified');
  });

  test('de-dup: one key in three task hints → ONE finding with occurrences 3; ids unique', async () => {
    const root = workspace({
      'sharkcraft/search-tuning.ts': `export default [{
  id: 't.repeat',
  taskHints: [
    { whenTokens: ['a1'], boostIds: { 'knowledge:nope.one': 1 } },
    { whenTokens: ['a2'], boostIds: { 'knowledge:nope.one': 1 } },
    { whenTokens: ['a3'], boostIds: { 'knowledge:nope.one': 1 } },
  ],
}];
`,
    });
    const i = await inspectSharkcraft({ cwd: root });
    const report = await buildSelfConfigDoctorReportV2(i);
    const missing = report.findings.filter((f) => f.code === 'search-tuning-target-missing');
    expect(missing).toHaveLength(1);
    expect(missing[0]!.occurrences).toBe(3);
    expect(missing[0]!.message).toContain('declared 3 times');
    const ids = report.findings.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  }, TIMEOUT_MS);

  test('a key present in `search tuning explain` composition is never reported target-missing', async () => {
    const report = await buildSelfConfigDoctorReportV2(insp);
    // The doctor's target-missing findings, rebuilt into the keys they name.
    const missingKeys = new Set(
      report.findings
        .filter((f) => f.code === 'search-tuning-target-missing')
        .map((f) => {
          const prefix = searchDocumentPrefixForReferenceKind(f.targetKind as ReferenceKind);
          return prefix ? searchDocumentId(prefix, f.targetId) : f.targetId;
        }),
    );
    expect(missingKeys).toEqual(new Set(['knowledge:does.not.exist']));
    const lintKeys = new Set(
      (await lintSearchTuning(insp)).issues.filter((i) => i.key && KEY_CODES.has(i.code)).map((i) => i.key!),
    );
    let seen = 0;
    for (const q of ['alpha widgets', 'beta widgets', 'foo widgets']) {
      const ex = await explainSearchTuning(insp, q, { topN: 10 });
      for (const hit of ex.topResults) {
        for (const c of hit.composition ?? []) {
          const m = /^(?:task-hint:)?id:(.+)$/.exec(c.key);
          if (!m) continue;
          seen += 1;
          const key = m[1]!;
          expect({ key, missing: missingKeys.has(key), dead: lintKeys.has(key) }).toEqual({
            key,
            missing: false,
            dead: false,
          });
        }
      }
    }
    expect(seen).toBeGreaterThan(0);
  }, TIMEOUT_MS);
});

describe('list ≡ resolve for tuning keys, on this repo', () => {
  let insp: ISharkcraftInspection;
  beforeAll(async () => {
    insp = await inspectSharkcraft({ cwd: REPO });
    await warmReferenceRegistries(insp);
  }, TIMEOUT_MS);

  test('every search document whose prefix names a registry resolves as a boost key', () => {
    let checked = 0;
    for (const doc of buildSearchIndex(insp)) {
      const parsed = parseSearchDocumentId(doc.id);
      if (!parsed || !isSearchDocumentPrefix(parsed.prefix)) continue;
      if (SEARCH_DOCUMENT_ID_KINDS[parsed.prefix] === null) continue;
      checked += 1;
      expect({ id: doc.id, status: resolveSearchTuningKey(insp, doc.id).status }).toEqual({
        id: doc.id,
        status: SearchTuningKeyStatus.Resolved,
      });
    }
    // A handful would make the property blind; the repo indexes well over this.
    expect(checked).toBeGreaterThan(40);
  });

  test('every knowledge id (the `knowledge get` lookup) resolves as `knowledge:<id>`', () => {
    expect(insp.knowledgeEntries.length).toBeGreaterThan(30);
    for (const k of insp.knowledgeEntries) {
      expect(resolveSearchTuningKey(insp, searchDocumentId('knowledge', k.id)).status).toBe(
        SearchTuningKeyStatus.Resolved,
      );
    }
  });

  test("shrk's own tuning now fires — explain shows id-keyed contributions", async () => {
    // Before the migration these queries showed only `task-hint:tag:*` keys:
    // every boostId in sharkcraft/search-tuning.ts was a dead bare id.
    let idKeyed = 0;
    for (const q of ['changed-only boundary', 'new mcp tool', 'stale knowledge']) {
      const ex = await explainSearchTuning(insp, q, { topN: 10 });
      for (const hit of ex.topResults) {
        idKeyed += (hit.composition ?? []).filter((c) => /^(?:task-hint:)?id:/.test(c.key)).length;
      }
    }
    expect(idKeyed).toBeGreaterThan(0);
    expect(tuningQueryTokens('changed-only boundary')).toContain('changed-only');
  }, TIMEOUT_MS);
});
