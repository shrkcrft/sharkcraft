/**
 * r76 — a self-config finding's `unknown:` target means "resolves in NO
 * registry" (round 12, 12.4).
 *
 * `unknown` was the fallback of a `switch` for every finding that carried no
 * kind, so a capped document read `tunes unknown:knowledge:gamma.entry` (the
 * index BUILT that document), a resolvable bare boost key, a clamped tag, a
 * `doc:` key, the finding CODE itself (`unknown:duplicate-trigger`), a facet
 * value whose declared KIND was typo'd, a pipeline step naming a construct and
 * the doctor's own command-probe summary (`unknown:self-config`) all read
 * `unknown:` — while the one really missing id rendered without it. That
 * re-created round 11's false-unknown alarm with nothing wrong underneath.
 *
 * The token is now reserved: only `selfKindOf(undefined)` produces it, and the
 * property below holds over every finding — a target labelled `unknown` is
 * placed by no registry, no search document, and no key resolution. Real
 * loaders, temp workspaces; rendered in-process (no CLI spawn).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspectSharkcraft, type ISharkcraftInspection } from '../sharkcraft-inspector.ts';
import {
  buildSelfConfigDoctorReportV2,
  renderSelfConfigDoctorV2Markdown,
  renderSelfConfigDoctorV2Text,
  SelfConfigSeverityV2,
  type ISelfConfigDoctorReportV2,
} from '../self-config-doctor-v2.ts';
import { projectSelfConfigDoctorV2ToV1 } from '../self-config-doctor.ts';
import { lintSearchTuning } from '../search-tuning-lint.ts';
import { listSearchTuningIssues } from '../search-tuning-registry.ts';
import { resolveSearchTuningKey } from '../search-tuning-key-resolver.ts';
import { SearchTuningKeyStatus } from '../search-tuning-key-status.ts';
import { referenceKindsOf } from '../reference-registry.ts';
import { buildSearchIndex } from '../search-index.ts';
import {
  isSearchDocumentPrefix,
  parseSearchDocumentId,
  SEARCH_DOCUMENT_PREFIXES,
  searchDocumentReference,
} from '../search-document-id.ts';
import { collectDeclaredXrefs } from '../declared-cross-references.ts';

const TIMEOUT_MS = 180_000;
const REPO = join(import.meta.dir, '..', '..', '..', '..');
const roots: string[] = [];

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function workspace(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r76-unknown-'));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

const KNOWLEDGE = `export default [
  { id: 'alpha.entry', title: 'Alpha entry', type: 'architecture', priority: 'high', tags: ['alpha'], content: 'Alpha content about widgets.' },
  { id: 'gamma.entry', title: 'Gamma entry', type: 'architecture', priority: 'low', tags: ['captag'], content: 'Gamma content about widgets.' },
];
`;

/** Every lint code, a clamp of each map kind, a capped registry-backed AND registry-less document, a facet kind typo, pipeline steps. */
const MAIN: Readonly<Record<string, string>> = {
  'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
  'sharkcraft/sharkcraft.config.ts': `export default { projectName: 'fx', knowledgeFiles: ['knowledge.ts'], ruleFiles: ['rules.ts'], pipelineFiles: ['pipelines.ts'] };\n`,
  'sharkcraft/knowledge.ts': KNOWLEDGE,
  'sharkcraft/rules.ts': `export default [{ id: 'fx.rule', title: 'Rule', type: 'rule', priority: 'high', scope: [], tags: [], appliesWhen: [], content: 'A rule about widgets.' }];\n`,
  'sharkcraft/constructs.ts': `export default [{
  id: 'fx-construct', type: 'service', title: 'Fixture construct', files: ['src/index.ts'], publicApi: ['src/index.ts'],
  facets: { 'bad-kind': [{ id: 'k1', value: 'alpha.entry', resolvesAs: ['knowlege'] }] },
}];
`,
  'sharkcraft/pipelines.ts': `export default [{ id: 'fx.pipe', title: 'Pipe', description: 'A pipeline.', steps: [
  { id: 's1', title: 'Wrong kind', type: 'agent', references: ['fx-construct'] },
  { id: 's2', title: 'Nowhere', type: 'agent', references: ['ghost.ref'] },
  { id: 's3', title: 'Accepted', type: 'agent', references: ['alpha.entry'] },
] }];
`,
  'src/index.ts': 'export const x = 1;\n',
  'docs/guide.md': '# Guide\n\nA guide about widgets.\n',
  'sharkcraft/search-tuning.ts': `export default [
  { id: 't.cap', boostTags: { captag: 5 }, boostIds: { 'knowledge:gamma.entry': 5 }, taskHints: [{ whenTokens: ['gamma'], boostIds: { 'knowledge:gamma.entry': 5 } }] },
  { id: 't.missing', boostIds: { 'knowledge:nope.entry': 1 } },
  { id: 't.unprefixed', boostIds: { 'alpha.entry': 1 } },
  { id: 't.unprefixed.nowhere', boostIds: { 'zzz.nowhere': 1 } },
  { id: 't.unknownkind', boostIds: { 'knowlege:alpha.entry': 1 } },
  { id: 't.excluded', appliesToKinds: ['template'], boostIds: { 'rule:fx.rule': 2 } },
  { id: 't.docexcluded', appliesToKinds: ['knowledge'], boostIds: { 'doc:README.md': 2 } },
  { id: 't.dup', taskHints: [
    { whenTokens: ['alpha'], boostIds: { 'knowledge:alpha.entry': 2 } },
    { whenTokens: ['alpha'], boostIds: { 'knowledge:alpha.entry': 1 } },
  ] },
  { id: 't.deadtokens', taskHints: [
    { whenTokens: ['x'], boostIds: { 'knowledge:alpha.entry': 1 } },
    { whenTokens: ['two words'], boostIds: { 'knowledge:alpha.entry': 1 } },
  ] },
  { id: 't.kindtypo', appliesToKinds: ['templat'], boostTags: { alpha: 1 } },
  { id: 't.source', boostSources: { packz: 1 } },
  { id: 't.clamp', boostIds: { 'knowledge:alpha.entry': 9 } },
  { id: 't.tagclamp', boostTags: { alpha: 9 } },
  { id: 't.badclamp', boostIds: { 'knowlege:gamma.entry': 8 } },
  { id: 't.docA', boostIds: { 'doc:guide.md': 5 } },
  { id: 't.docB', boostIds: { 'doc:guide.md': 5 } },
  { id: 't.docC', boostIds: { 'doc:guide.md': 5 } },
];
`,
};

/** 23 capped documents: 20 cap-discards issues, then the summary. */
const OVER_CAP: Readonly<Record<string, string>> = {
  'package.json': JSON.stringify({ name: 'fx2', version: '0.0.0' }),
  'sharkcraft/sharkcraft.config.ts': `export default { projectName: 'fx2', knowledgeFiles: ['knowledge.ts'] };\n`,
  'sharkcraft/knowledge.ts': `export default [\n${Array.from(
    { length: 23 },
    (_, i) =>
      `  { id: 'cap.e${i + 1}', title: 'Cap entry ${i + 1}', type: 'architecture', priority: 'low', tags: ['captag'], content: 'Cap content ${i + 1}.' },`,
  ).join('\n')}\n];\n`,
  'sharkcraft/search-tuning.ts': `export default [
  { id: 't.a', boostTags: { captag: 5 } },
  { id: 't.b', boostTags: { captag: 5 } },
  { id: 't.c', boostTags: { captag: 5 } },
];
`,
};

type Row = readonly [code: string, sourceId: string, relation: string, targetKind: string, targetId: string];

const LABELLED = /^(search-tuning-|xref-|pipeline-)/;

function rows(report: ISelfConfigDoctorReportV2): Row[] {
  return report.findings
    .filter((f) => LABELLED.test(f.code))
    .map((f): Row => [f.code, f.sourceId, f.relation, f.targetKind, f.targetId])
    .sort((a, b) => a.join('|').localeCompare(b.join('|')));
}

function sorted(list: readonly Row[]): Row[] {
  return [...list].sort((a, b) => a.join('|').localeCompare(b.join('|')));
}

/**
 * Every `unknown` target that DOES resolve somewhere, with why — the property
 * is that this is empty. The four answers are the four authorities a target
 * could be placed by: THE id resolver, the search index, THE key resolver,
 * and the finding-code vocabulary (the old fallback used the code as the id).
 */
function falseUnknowns(insp: ISharkcraftInspection, report: ISelfConfigDoctorReportV2): string[] {
  const docIds = new Set(buildSearchIndex(insp).map((d) => d.id));
  const codes = new Set(report.findings.flatMap((f) => [f.code, f.code.replace(/^search-tuning-/, '')]));
  const out: string[] = [];
  for (const f of report.findings) {
    if (f.targetKind !== 'unknown') continue;
    const id = f.targetId;
    const kinds = referenceKindsOf(insp, id);
    const status = resolveSearchTuningKey(insp, id).status;
    const why = [
      kinds.length > 0 ? `resolves as ${kinds.join(' | ')}` : '',
      docIds.has(id) ? 'is a search document' : '',
      status === SearchTuningKeyStatus.Resolved || status === SearchTuningKeyStatus.Unverified ? `key ${status}` : '',
      codes.has(id) ? 'is a finding code' : '',
    ].filter((w) => w.length > 0);
    if (why.length > 0) out.push(`${f.code} ${f.sourceKind}:${f.sourceId} → unknown:${id} (${why.join(', ')})`);
  }
  return out;
}

describe('r76 — `unknown:` is reserved for a target that resolves nowhere', () => {
  let insp: ISharkcraftInspection;
  let report: ISelfConfigDoctorReportV2;
  let capInsp: ISharkcraftInspection;
  let capReport: ISelfConfigDoctorReportV2;

  beforeAll(async () => {
    insp = await inspectSharkcraft({ cwd: workspace(MAIN) });
    report = await buildSelfConfigDoctorReportV2(insp);
    capInsp = await inspectSharkcraft({ cwd: workspace(OVER_CAP) });
    capReport = await buildSelfConfigDoctorReportV2(capInsp);
  }, TIMEOUT_MS);

  test('the exact target of every search-tuning / xref / pipeline finding', () => {
    expect(rows(report)).toEqual(
      sorted([
        // Keys and documents the resolvers place: `<kind>:<id>`.
        ['search-tuning-target-missing', 't.missing', 'tunes', 'knowledge', 'nope.entry'],
        ['search-tuning-key-unprefixed', 't.unprefixed', 'tunes', 'knowledge', 'alpha.entry'],
        ['search-tuning-boost-excluded-by-kind', 't.excluded', 'tunes', 'rule', 'fx.rule'],
        ['search-tuning-cap-discards', 't.cap', 'tunes', 'knowledge', 'gamma.entry'],
        ['search-tuning-cap-discards', 't.clamp+t.dup+t.tagclamp', 'tunes', 'knowledge', 'alpha.entry'],
        ['search-tuning-boost-clamped', 't.clamp', 'validates', 'knowledge', 'alpha.entry'],
        ['pipeline-reference-wrong-kind', 'fx.pipe', 'references', 'construct', 'fx-construct'],
        // No id registry: a search document, never unknown.
        ['search-tuning-boost-excluded-by-kind', 't.docexcluded', 'tunes', 'search-document', 'doc:README.md'],
        ['search-tuning-cap-discards', 't.docA+t.docB+t.docC', 'tunes', 'search-document', 'doc:guide.md'],
        // Declaration-shape findings name the field, not an id.
        ['search-tuning-duplicate-trigger', 't.dup', 'validates', 'schema', 'taskHints[1].whenTokens'],
        ['search-tuning-unreachable-trigger', 't.deadtokens', 'validates', 'schema', 'taskHints[0].whenTokens'],
        ['search-tuning-unreachable-trigger', 't.deadtokens', 'validates', 'schema', 'taskHints[1].whenTokens'],
        ['search-tuning-unknown-kind', 't.kindtypo', 'validates', 'schema', 'appliesToKinds'],
        ['search-tuning-unknown-source', 't.source', 'validates', 'schema', 'boostSources'],
        ['search-tuning-boost-clamped', 't.tagclamp', 'validates', 'schema', 'boostTags.alpha'],
        ['xref-unknown-kind', 'fx-construct', 'validates', 'schema', 'facets.bad-kind[k1]'],
        // The genuine cases — resolved nowhere. An unknown prefix names the WHOLE
        // key: its right-hand id (alpha.entry, gamma.entry) does exist.
        ['search-tuning-key-unprefixed', 't.unprefixed.nowhere', 'tunes', 'unknown', 'zzz.nowhere'],
        ['search-tuning-key-unknown-kind', 't.unknownkind', 'tunes', 'unknown', 'knowlege:alpha.entry'],
        ['search-tuning-key-unknown-kind', 't.badclamp', 'tunes', 'unknown', 'knowlege:gamma.entry'],
        ['search-tuning-boost-clamped', 't.badclamp', 'validates', 'unknown', 'knowlege:gamma.entry'],
        ['pipeline-reference-missing', 'fx.pipe', 'references', 'unknown', 'ghost.ref'],
      ]),
    );
  });

  test('the cap summary names its documents as search documents', () => {
    const cap = capReport.findings.filter((f) => f.code === 'search-tuning-cap-discards');
    expect(cap).toHaveLength(21);
    expect(cap.filter((f) => f.targetKind === 'knowledge')).toHaveLength(20);
    const summary = cap.find((f) => f.sourceId === '(combined)');
    expect(summary && [summary.relation, summary.targetKind, summary.targetId]).toEqual([
      'tunes',
      'search-document',
      '3 more document(s)',
    ]);
    expect(capReport.totals.byTargetKind['unknown']).toBeUndefined();
  });

  test('PROPERTY: targetKind unknown ⇒ the target resolves nowhere (non-vacuous)', () => {
    expect(falseUnknowns(insp, report)).toEqual([]);
    expect(falseUnknowns(capInsp, capReport)).toEqual([]);
    const genuine = new Set(report.findings.filter((f) => f.targetKind === 'unknown').map((f) => f.targetId));
    expect([...genuine].sort()).toEqual(['ghost.ref', 'knowlege:alpha.entry', 'knowlege:gamma.entry', 'zzz.nowhere']);
  });

  test('a search-document target is a registry-less document, or the cap summary', () => {
    const docs = [...report.findings, ...capReport.findings].filter((f) => f.targetKind === 'search-document');
    expect(docs.length).toBeGreaterThanOrEqual(3);
    for (const f of docs) {
      const parsed = parseSearchDocumentId(f.targetId);
      const registryLess =
        parsed !== null && isSearchDocumentPrefix(parsed.prefix) && searchDocumentReference(f.targetId) === undefined;
      expect({ id: f.targetId, ok: registryLess || /^\d+ more document\(s\)$/.test(f.targetId) }).toEqual({
        id: f.targetId,
        ok: true,
      });
    }
  });

  test('the doctor itself has a kind: command-probe-unverified is self-config:command-probes, no source is unknown', () => {
    // No command resolver is injected here (a direct engine call, as over MCP).
    const probe = report.findings.filter((f) => f.code === 'command-probe-unverified');
    expect(probe.map((f) => `${f.sourceKind}:${f.sourceId}`)).toEqual(['self-config:command-probes']);
    expect([...report.findings, ...capReport.findings].filter((f) => f.sourceKind === 'unknown')).toEqual([]);
    expect(report.totals.bySourceKind['unknown']).toBeUndefined();
  });

  test('rendered text / markdown: the capped document reads as itself; a document id never sits behind unknown:', () => {
    const behindUnknown = new RegExp(`unknown:(${SEARCH_DOCUMENT_PREFIXES.join('|')}):`);
    for (const r of [report, capReport]) {
      for (const text of [renderSelfConfigDoctorV2Text(r), renderSelfConfigDoctorV2Markdown(r)]) {
        expect(text.split('\n').filter((l) => behindUnknown.test(l))).toEqual([]);
      }
    }
    const text = renderSelfConfigDoctorV2Text(report);
    expect(text).toContain('search-tuning:t.cap tunes knowledge:gamma.entry');
    expect(text).toContain('construct:fx-construct validates schema:facets.bad-kind[k1]');
    expect(text).toContain('pipeline:fx.pipe references construct:fx-construct');
    // The genuine ones keep the token.
    expect(text).toContain('search-tuning:t.unprefixed.nowhere tunes unknown:zzz.nowhere');
    expect(text).toContain('pipeline:fx.pipe references unknown:ghost.ref');
  });

  test('v1 / MCP default: the projection carries the same kind (referencedKind)', () => {
    const v1 = projectSelfConfigDoctorV2ToV1(report);
    const cap = v1.findings.find((f) => f.code === 'search-tuning-cap-discards' && f.referencingId === 't.cap');
    expect(cap && [cap.referencedKind, cap.referencedId]).toEqual(['knowledge', 'gamma.entry']);
    const clamped = v1.findings.find((f) => f.code === 'search-tuning-boost-clamped' && f.referencingId === 't.clamp');
    expect(clamped?.referencedKind).toBe('knowledge');
    expect(v1.findings.filter((f) => f.referencedKind === 'unknown').map((f) => f.referencedId).sort()).toEqual(
      ['ghost.ref', 'knowlege:alpha.entry', 'knowlege:gamma.entry', 'knowlege:gamma.entry', 'zzz.nowhere'].sort(),
    );
  });

  test('the wrong-kind step reference says what it IS and how to look it up; missing keeps its code', () => {
    const wrong = report.findings.find((f) => f.code === 'pipeline-reference-wrong-kind');
    expect(wrong?.severity).toBe(SelfConfigSeverityV2.Info);
    expect(wrong?.message).toContain('references "fx-construct", which is a construct');
    expect(wrong?.nextCommand).toBe('shrk self-config resolve fx-construct');
    const missing = report.findings.find((f) => f.code === 'pipeline-reference-missing');
    expect(missing?.message).toBe('Pipeline "fx.pipe" step "s2" references unknown id "ghost.ref".');
    // An accepted reference (a knowledge id) is no finding at all.
    expect(report.findings.filter((f) => f.sourceKind === 'pipeline' && f.targetId === 'alpha.entry')).toEqual([]);
  });

  test('THE lint / loader / resolver carry the locators additively (codes and messages unchanged)', async () => {
    const lint = await lintSearchTuning(insp);
    const cap = lint.issues.find((i) => i.code === 'cap-discards' && i.docId === 'knowledge:gamma.entry');
    expect(cap).toMatchObject({ referenceKind: 'knowledge', targetId: 'gamma.entry', tuningId: 't.cap' });
    expect(cap?.message).toBe(
      'Tuning on "knowledge:gamma.entry" composes to +15 for a query containing [gamma]; the ±10 total cap discards 5 (from t.cap).',
    );
    const docCap = lint.issues.find((i) => i.code === 'cap-discards' && i.docId === 'doc:guide.md');
    expect(docCap?.referenceKind).toBeUndefined();
    const field = (code: string, tuningId: string): (string | undefined)[] =>
      lint.issues.filter((i) => i.code === code && i.tuningId === tuningId).map((i) => i.field);
    expect(field('duplicate-trigger', 't.dup')).toEqual(['taskHints[1].whenTokens']);
    expect(field('unreachable-trigger', 't.deadtokens')).toEqual(['taskHints[0].whenTokens', 'taskHints[1].whenTokens']);
    expect(field('unknown-kind', 't.kindtypo')).toEqual(['appliesToKinds']);
    expect(field('unknown-source', 't.source')).toEqual(['boostSources']);

    const summary = (await lintSearchTuning(capInsp)).issues.find((i) => i.code === 'cap-discards' && !i.docId);
    expect(summary).toMatchObject({ tuningId: '(combined)', moreDocuments: 3 });

    const clamped = listSearchTuningIssues(insp).filter((i) => i.code === 'boost-clamped');
    expect(clamped.map((i) => `${i.tuningId} ${i.field} ${i.key}`).sort()).toEqual([
      't.badclamp boostIds knowlege:gamma.entry',
      't.clamp boostIds knowledge:alpha.entry',
      't.tagclamp boostTags alpha',
    ]);

    const bare = resolveSearchTuningKey(insp, 'alpha.entry');
    expect([bare.status, bare.suggestion, bare.referenceKind]).toEqual([
      SearchTuningKeyStatus.Unprefixed,
      'knowledge:alpha.entry',
      'knowledge',
    ]);
    expect(resolveSearchTuningKey(insp, 'zzz.nowhere').referenceKind).toBeUndefined();
    expect(searchDocumentReference('knowledge:gamma.entry')).toEqual({ referenceKind: 'knowledge', id: 'gamma.entry' });
    expect(searchDocumentReference('doc:guide.md')).toBeUndefined();
    expect(searchDocumentReference('nope')).toBeUndefined();
  });

  test('THE xref collector names the facet value an unknown-kind issue is about', () => {
    const issue = collectDeclaredXrefs(insp).issues.find((i) => i.code === 'xref-unknown-kind');
    expect(issue && [issue.field, issue.facetId, issue.targetId]).toEqual(['facets.bad-kind', 'k1', 'alpha.entry']);
    // The value resolves — the declared KIND is what is wrong.
    expect(referenceKindsOf(insp, 'alpha.entry')).toEqual(['knowledge']);
  });
});

describe('r76 — the property on this repository', () => {
  test(
    'no `unknown:` target in shrk\'s own self-config doctor resolves anywhere',
    async () => {
      const insp = await inspectSharkcraft({ cwd: REPO });
      const report = await buildSelfConfigDoctorReportV2(insp);
      expect(falseUnknowns(insp, report)).toEqual([]);
      expect(report.findings.filter((f) => f.sourceKind === 'unknown')).toEqual([]);
    },
    TIMEOUT_MS,
  );
});

describe('r76 — source lock: `unknown` comes only from selfKindOf(undefined)', () => {
  test('self-config-doctor-v2.ts spells the literal only in the union and THE one constant', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'self-config-doctor-v2.ts'), 'utf8');
    const code = src.split('\n').map((line, i) => ({ n: i + 1, line })).filter(({ line }) => !/^\s*(\*|\/\/|\/\*)/.test(line));
    const union = code.filter(({ line }) => /^\s*\| 'unknown';?\s*$/.test(line));
    const constant = code.filter(({ line }) => /^const RESOLVED_NOWHERE: SelfConfigKind = 'unknown';$/.test(line.trim()));
    expect([union.length, constant.length]).toEqual([1, 1]);
    const offenders = code
      .filter(({ line }) => line.includes("'unknown'"))
      .filter((l) => !union.includes(l) && !constant.includes(l))
      .map(({ n, line }) => `${n}: ${line.trim()}`);
    expect(offenders).toEqual([]);
    // The plan's three shapes, spelled out.
    expect(src).not.toMatch(/targetKind:\s*'unknown'/);
    expect(src).not.toMatch(/sourceKind:\s*'unknown'/);
    expect(src).not.toMatch(/\?\s*'unknown'\s*:/);
  });
});
