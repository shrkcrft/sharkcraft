/**
 * Round 11, 4.2 — cross-reference ids in declared asset fields are resolved,
 * in every direction.
 *
 * Before: a knowledge entry's `related` / action hints, a construct's
 * `related*` and facets, a boundary rule's `related*` and a template's
 * `related` were resolved by NOTHING — every doctor printed ✓ over ids no
 * registry had, `templates drift` flagged real construct / boundary ids through
 * a private lookup, and `knowledge remove` let an entry a construct relied on
 * be removed. Now ONE collector (`DECLARED_XREF_FIELDS`, resolved through the
 * reference registry) answers, and every consumer reads it — the agreement
 * block below is the lock against a second walker.
 *
 * Real registries only: the fixture is a real workspace (a real pack under
 * node_modules) loaded through `inspectSharkcraft`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { coverageShortfall } from '@shrkcrft/core';
import { formatEntryFull } from '@shrkcrft/knowledge';
import {
  buildDeclaredXrefReport,
  buildKnowledgeRefResolver,
  collectDeclaredXrefs,
  declaredXrefCoverage,
  isBrokenXref,
  KNOWLEDGE_BACKED_KINDS,
  reverseXrefs,
  withDeclaredXrefEdges,
} from '../declared-cross-references.ts';
import { DeclaredXrefStatus } from '../declared-xref-status.ts';
import type { IDeclaredXrefReport } from '../i-declared-xref-report.ts';
import { buildKnowledgeAuthoringPreview, KnowledgeAuthoringOperation } from '../knowledge-authoring.ts';
import { buildKnowledgeGraph } from '../knowledge-graph.ts';
import { buildPackDoctorReportAsync } from '../pack-doctor.ts';
import { buildQualityReport } from '../quality-report.ts';
import { inspectionReferenceLookup } from '../reference-lookup.ts';
import { isReferenceCacheWarm, referenceKindOf, referenceKindsOf } from '../reference-registry.ts';
import { buildSelfConfigDoctorReport, buildSelfConfigGraph } from '../self-config-doctor.ts';
import { buildSelfConfigDoctorReportV2 } from '../self-config-doctor-v2.ts';
import { inspectSharkcraft, type ISharkcraftInspection } from '../sharkcraft-inspector.ts';
import { buildTemplateDriftReport } from '../template-drift.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const k = (id: string, extra = ''): string =>
  `{ id: '${id}', title: 'T ${id}', type: 'architecture', priority: 'medium', scope: ['typescript'], tags: ['t'], appliesWhen: ['onboard'], content: 'Body of ${id}.'${extra ? `, ${extra}` : ''} }`;

/** A real workspace declaring every cross-reference field, dangling and live. */
function fixture(withPack: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-xref-'));
  roots.push(root);
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'r75-xref-fixture', version: '0.0.0', private: true }),
    'src/index.ts': 'export const x = 1;\n',
    'sharkcraft/sharkcraft.config.ts': `export default {
  projectName: 'r75-xref-fixture',
  knowledgeFiles: ['knowledge.ts'],
  ruleFiles: ['rules.ts'],
  pathFiles: ['paths.ts'],
  templateFiles: ['templates.ts'],
  boundaryFiles: ['boundaries.ts'],
};
`,
    'sharkcraft/knowledge.ts': `export default [
  ${k('app.overview', `related: ['app.ghost-entry', 'ghost.rule-in-related'], actionHints: { relatedKnowledge: ['app.ghost-knowledge'], relatedTemplates: ['ghost.template-hint'], relatedPathConventions: ['ghost.path-hint'] }`)},
  ${k('app.old-way', `supersededBy: ['app.new-way'], seeAlso: ['fx.rule.one']`)},
  ${k('app.valid', `related: ['app.overview', 'fx.rule.one', 'fx-construct']`)},
  ${k('app.cycle-a', `supersededBy: ['app.cycle-b']`)},
  ${k('app.cycle-b', `supersededBy: ['app.cycle-a']`)},
  ${k('app.chain-a', `supersededBy: ['app.chain-b']`)},
  ${k('app.chain-b', `supersededBy: ['app.chain-c']`)},
  ${k('app.chain-c')},
];
`,
    'sharkcraft/rules.ts': `export default [{ id: 'fx.rule.one', title: 'Rule one', type: 'rule', priority: 'high', scope: ['typescript'], tags: ['rule'], appliesWhen: ['generate-code'], content: 'Rule one content.' }];\n`,
    'sharkcraft/paths.ts': `export default [{ id: 'fx.path.src', title: 'Source root', type: 'path', priority: 'medium', scope: ['typescript'], tags: ['path'], appliesWhen: ['generate-code'], content: 'Canonical path: src', metadata: { path: 'src' } }];\n`,
    'sharkcraft/templates.ts': `export default [
  { id: 'fx.service', name: 'Svc', description: 'Renders a service.', tags: ['demo'], scope: ['typescript'], appliesWhen: ['generate-code'], variables: [{ name: 'name', required: true }], targetPath: ({ name }: { name: string }) => 'src/' + name + '.ts', content: () => 'export {};\\n', related: ['ghost.template-related'] },
  { id: 'fx.service-two', name: 'Svc2', description: 'Related ids that exist.', tags: ['demo'], scope: ['typescript'], appliesWhen: ['generate-code'], variables: [{ name: 'name', required: true }], targetPath: ({ name }: { name: string }) => 'src/' + name + '2.ts', content: () => 'export {};\\n', related: ['fx-construct', 'fx.no-forbidden', 'fx.path.src'] },
];
`,
    'sharkcraft/boundaries.ts': `export default [{ id: 'fx.no-forbidden', title: 'src may not import forbidden-pkg', severity: 'error', from: ['src/**'], forbiddenImports: ['forbidden-pkg'], relatedRules: ['ghost.rule-c'], relatedPathConventions: ['ghost.path-c'] }];\n`,
    'sharkcraft/constructs.ts': `export default [{
  id: 'fx-construct', type: 'service', title: 'Fixture construct', files: ['src/index.ts'], publicApi: ['src/index.ts'],
  relatedRules: ['ghost.rule-a', 'ghost.rule-b', 'fx.service'],
  relatedPathConventions: ['ghost.path-a', 'ghost.path-b'],
  relatedKnowledge: ['ghost.knowledge-a', 'app.old-way'],
  relatedTemplates: ['ghost.template-a'],
  relatedPipelines: ['ghost.pipeline-a'],
  facets: {
    'boundary-rules': [
      { id: 'b1', value: 'ghost.boundary-a', resolvesAs: ['boundary-rule'] },
      { id: 'b2', value: 'fx.no-forbidden', resolvesAs: ['boundary-rule'] },
    ],
    'bad-kind': [{ id: 'k1', value: 'whatever', resolvesAs: ['bogus'] }],
    topics: [{ id: 't1', value: 'order.created' }, { id: 't2', value: 'order.shipped' }],
  },
}];
`,
  };
  if (withPack) {
    const pack = 'node_modules/@r75/xpack';
    files[`${pack}/package.json`] = JSON.stringify({ name: '@r75/xpack', version: '0.0.1', sharkcraft: { manifest: './manifest.json' } });
    files[`${pack}/manifest.json`] = JSON.stringify({
      schema: 'sharkcraft.pack/v1',
      info: { name: '@r75/xpack', version: '0.0.1' },
      contributions: { knowledgeFiles: ['./k.ts'], templateFiles: ['./t.ts'] },
    });
    files[`${pack}/k.ts`] = `export default [${k('xpack.entry', `related: ['xpack.ghost'], supersededBy: ['xpack.gone']`)}];\n`;
    files[`${pack}/t.ts`] = `export default [{ id: 'xpack.tpl', name: 'P', description: 'Pack template.', tags: [], scope: [], appliesWhen: [], variables: [], targetPath: 'src/p.ts', content: 'export {};\\n', related: ['xpack.ghost-tpl', 'app.overview'] }];\n`;
  }
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

const label = (r: { sourceKind: string; sourceId: string; field: string; targetId: string }): string =>
  `${r.sourceKind}:${r.sourceId} ${r.field} → ${r.targetId}`;

let inspection: ISharkcraftInspection;
let report: IDeclaredXrefReport;

beforeAll(async () => {
  inspection = await inspectSharkcraft({ cwd: fixture(true) });
  report = await buildDeclaredXrefReport(inspection);
}, 60_000);

describe('the collector resolves every declared field', () => {
  test('every dangling id is a row naming its source, field and file', () => {
    const dangling = report.rows.filter((r) => r.status === DeclaredXrefStatus.Dangling).map(label).sort();
    expect(dangling).toEqual(
      [
        'knowledge:app.overview related → app.ghost-entry',
        'knowledge:app.overview related → ghost.rule-in-related',
        'knowledge:app.overview actionHints.relatedKnowledge → app.ghost-knowledge',
        'knowledge:app.overview actionHints.relatedTemplates → ghost.template-hint',
        'knowledge:app.overview actionHints.relatedPathConventions → ghost.path-hint',
        'knowledge:app.old-way supersededBy → app.new-way',
        'knowledge:xpack.entry related → xpack.ghost',
        'knowledge:xpack.entry supersededBy → xpack.gone',
        'construct:fx-construct relatedKnowledge → ghost.knowledge-a',
        'construct:fx-construct relatedRules → ghost.rule-a',
        'construct:fx-construct relatedRules → ghost.rule-b',
        'construct:fx-construct relatedTemplates → ghost.template-a',
        'construct:fx-construct relatedPipelines → ghost.pipeline-a',
        'construct:fx-construct relatedPathConventions → ghost.path-a',
        'construct:fx-construct relatedPathConventions → ghost.path-b',
        'construct:fx-construct facets.boundary-rules → ghost.boundary-a',
        'boundary-rule:fx.no-forbidden relatedRules → ghost.rule-c',
        'boundary-rule:fx.no-forbidden relatedPathConventions → ghost.path-c',
        'template:fx.service related → ghost.template-related',
        'template:xpack.tpl related → xpack.ghost-tpl',
      ].sort(),
    );
    const construct = report.rows.find((r) => r.targetId === 'ghost.rule-a');
    expect(construct?.file).toBe('sharkcraft/constructs.ts');
    expect(construct?.severity).toBe('warning');
    expect(report.rows.find((r) => r.targetId === 'app.ghost-entry')?.file).toBe('sharkcraft/knowledge.ts');
    expect(report.rows.find((r) => r.targetId === 'xpack.ghost')?.packageName).toBe('@r75/xpack');
  });

  test('a live id resolves ok, listing EVERY namespace it lives in (most specific first)', () => {
    const ok = (sourceId: string, targetId: string) =>
      report.rows.find((r) => r.sourceId === sourceId && r.targetId === targetId);
    expect(ok('app.valid', 'fx.rule.one')?.status).toBe(DeclaredXrefStatus.Ok);
    expect(ok('app.valid', 'fx.rule.one')?.resolvedAs).toEqual(['rule', 'knowledge']);
    expect(ok('app.valid', 'fx-construct')?.resolvedAs).toEqual(['construct']);
    expect(ok('fx.service-two', 'fx.no-forbidden')?.resolvedAs).toEqual(['boundary-rule']);
    expect(ok('fx.service-two', 'fx.path.src')?.resolvedAs).toEqual(['path-convention', 'knowledge']);
  });

  test('an id in the wrong namespace is wrong-kind, not ok', () => {
    const row = report.rows.find((r) => r.field === 'relatedRules' && r.targetId === 'fx.service');
    expect(row?.status).toBe(DeclaredXrefStatus.WrongKind);
    expect(row?.resolvedAs).toEqual(['template']);
    expect(row?.message).toContain('the field accepts rule | boundary-rule');
  });

  test('facets: declared values resolve, free-form ones are counted, an unknown kind is an error', () => {
    const facet = report.rows.filter((r) => r.field === 'facets.boundary-rules');
    expect(facet.map((r) => `${r.facetId}:${r.status}`).sort()).toEqual(['b1:dangling', 'b2:ok']);
    const unknown = report.issues.filter((i) => i.code === 'xref-unknown-kind');
    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.severity).toBe('error');
    expect(unknown[0]?.message).toContain('"bogus"');
    expect(report.examined.facetValuesUndeclared).toBe(2);
  });

  test('supersededBy: a dangling successor is an ERROR, a cycle is an error, a chain names the current entry', () => {
    const dead = report.rows.find((r) => r.sourceId === 'app.old-way' && r.field === 'supersededBy');
    expect(dead?.severity).toBe('error');
    const cycle = report.issues.find((i) => i.code === 'xref-superseded-cycle');
    expect(cycle?.severity).toBe('error');
    expect(cycle?.sourceId).toBe('app.cycle-a');
    expect(cycle?.targetId).toBe('app.cycle-b');
    const chain = report.issues.find((i) => i.code === 'xref-superseded-chain');
    expect(chain?.severity).toBe('warning');
    expect(chain?.sourceId).toBe('app.chain-a');
    expect(chain?.message).toContain('"app.chain-c"');
  });

  test('what it examined is visible, and a fully-examined run has no shortfall', () => {
    expect(report.examined.ids).toBe(report.rows.length);
    expect(report.counts.ids).toBe(35);
    expect(report.counts.dangling).toBe(20);
    expect(report.counts.wrongKind).toBe(1);
    expect(report.examined.cacheWarm).toBe(true);
    expect(report.examined.unreadSources).toEqual([]);
    expect(coverageShortfall(declaredXrefCoverage(report))).toBeUndefined();
  });

  test('reverseXrefs: who points at an entry, across every source kind', () => {
    const back = reverseXrefs(report, 'app.old-way', KNOWLEDGE_BACKED_KINDS).map(label);
    expect(back).toEqual(['construct:fx-construct relatedKnowledge → app.old-way']);
  });
});

describe('a cold registry is NOT VERIFIED — never a false dangling id', () => {
  test('unwarmed: an id that could live in an async registry is unverified, and the coverage has a shortfall', async () => {
    const cold = await inspectSharkcraft({ cwd: fixture(false) });
    expect(isReferenceCacheWarm(cold)).toBe(false);
    const r = collectDeclaredXrefs(cold);
    expect(r.examined.cacheWarm).toBe(false);
    expect(r.examined.unreadSources).toEqual(['construct']);
    // `fx-construct` IS registered — cold, it must not read as dangling.
    expect(r.rows.find((x) => x.sourceId === 'app.valid' && x.targetId === 'fx-construct')?.status).toBe(
      DeclaredXrefStatus.Unverified,
    );
    // No field that could hold a cache-backed id is ever reported dangling cold.
    expect(r.rows.filter((x) => x.accepts === 'any' && x.status === DeclaredXrefStatus.Dangling)).toEqual([]);
    // A synchronous registry is trustworthy cold: a dead rule id is still dangling.
    expect(r.rows.find((x) => x.targetId === 'ghost.rule-c')?.status).toBe(DeclaredXrefStatus.Dangling);
    expect(coverageShortfall(declaredXrefCoverage(r))).toBeDefined();
  }, 60_000);
});

describe('one question, one answer — every consumer reports the collector\'s broken set', () => {
  const broken = (): IDeclaredXrefReport['rows'] => report.rows.filter(isBrokenXref);

  test('self-config doctor v2 and its v1 projection', async () => {
    const want = new Set(broken().map((r) => `${r.sourceId}→${r.targetId}`));
    const v2 = await buildSelfConfigDoctorReportV2(inspection);
    const v2Pairs = new Set(
      v2.findings
        .filter((f) => f.code === 'xref-dangling' || f.code === 'xref-wrong-kind')
        .map((f) => `${f.sourceId}→${f.targetId}`),
    );
    expect(v2Pairs).toEqual(want);
    expect(v2.crossReferences?.counts.dangling).toBe(20);
    expect(v2.coverage.some((c) => c.subject === 'declared cross-references')).toBe(true);
    const v1 = await buildSelfConfigDoctorReport(inspection);
    const v1Pairs = new Set(
      v1.findings
        .filter((f) => f.code === 'xref-dangling' || f.code === 'xref-wrong-kind')
        .map((f) => `${f.referencingId}→${f.referencedId}`),
    );
    expect(v1Pairs).toEqual(want);
  }, 60_000);

  test('self-config graph brokenEdges (what `broken-links` lists)', async () => {
    const graph = withDeclaredXrefEdges(await buildSelfConfigGraph(inspection), report);
    const edges = new Set(
      graph.brokenEdges.filter((e) => e.relation !== 'references').map((e) => `${e.from.id} ${e.relation} → ${e.to.id}`),
    );
    expect(edges).toEqual(new Set(broken().map((r) => `${r.sourceId} ${r.field} → ${r.targetId}`)));
  }, 60_000);

  test('packs doctor: exactly the pack-owned broken rows', async () => {
    const doctor = await buildPackDoctorReportAsync(inspection);
    const issues = doctor.issues.filter((i) => i.code === 'pack-xref-dangling' || i.code === 'pack-xref-wrong-kind');
    const packRows = broken().filter((r) => r.packageName === '@r75/xpack');
    expect(issues).toHaveLength(packRows.length);
    for (const row of packRows) expect(issues.some((i) => i.message.startsWith(row.message))).toBe(true);
    // The dangling supersededBy keeps its error severity in the pack doctor too.
    expect(issues.find((i) => i.message.includes('xpack.gone'))?.severity).toBe('error');
    // A local asset never becomes a pack issue.
    expect(issues.some((i) => i.message.includes('fx-construct'))).toBe(false);
  }, 60_000);

  test('templates drift: the collector\'s template rows — real construct / boundary ids are no longer "unresolved"', () => {
    const drift = buildTemplateDriftReport(inspection);
    const unresolved = drift.entries.flatMap((e) =>
      e.issues.filter((i) => i.code === 'related-id-unresolved').map((i) => `${e.templateId}:${/"([^"]+)"/.exec(i.message)?.[1]}`),
    );
    expect(unresolved.sort()).toEqual(['fx.service:ghost.template-related', 'xpack.tpl:xpack.ghost-tpl']);
    const two = drift.entries.find((e) => e.templateId === 'fx.service-two');
    expect(two?.issues.filter((i) => i.code.startsWith('related-id'))).toEqual([]);
  });

  test('shrk quality carries a cross-references gate with its coverage record', async () => {
    const q = await buildQualityReport({ inspection, config: {} });
    const gate = q.gates.find((g) => g.id === 'cross-references');
    expect(gate?.executed).toBe(true);
    expect(gate?.passed).toBe(false);
    expect(gate?.blocking).toBe(true); // error-severity rows: dangling supersededBy, cycle, unknown kind
    expect(gate?.data?.['ids']).toBe(35);
    expect((gate?.data?.['coverage'] as { unit: string }).unit).toBe('declared cross-reference ids');
  }, 120_000);
});

describe('knowledge remove sees reverse links from every namespace', () => {
  test('an entry only a construct points at is refused, naming the construct', () => {
    const result = buildKnowledgeAuthoringPreview(
      { operation: KnowledgeAuthoringOperation.Remove, id: 'app.old-way' },
      { entries: inspection.knowledgeEntries, declaredXrefs: report },
    );
    expect(result.ok).toBe(false);
    expect(result.reverseReferences).toEqual([
      { fromEntryId: 'fx-construct', sourceKind: 'construct', field: 'relatedKnowledge' },
    ]);
    expect(result.refusal).toContain('constructs / boundary rules / templates');
  });

  test('without the report the check covers knowledge only, and says so', () => {
    const result = buildKnowledgeAuthoringPreview(
      { operation: KnowledgeAuthoringOperation.Remove, id: 'app.old-way' },
      { entries: inspection.knowledgeEntries },
    );
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.includes('knowledge only'))).toBe(true);
  });
});

describe('the private resolvers answer from the one registry', () => {
  test('referenceKindOf names the most specific kind (rule / path-convention before knowledge)', () => {
    expect(referenceKindOf(inspection, 'fx.rule.one')).toBe('rule');
    expect(referenceKindsOf(inspection, 'fx.rule.one')).toEqual(['rule', 'knowledge']);
    expect(referenceKindOf(inspection, 'fx.path.src')).toBe('path-convention');
    expect(referenceKindsOf(inspection, 'nope.nothing')).toEqual([]);
  });

  test('the preset reference lookup is a projection of the registry', () => {
    const lookup = inspectionReferenceLookup(inspection);
    expect(lookup.hasTemplate('fx.service')).toBe(true);
    expect(lookup.hasTemplate('xpack.tpl')).toBe(true);
    expect(lookup.hasRule('fx.rule.one')).toBe(true);
    expect(lookup.hasPath('fx.path.src')).toBe(true);
    expect(lookup.hasPipeline('ghost.pipeline-a')).toBe(false);
  });

  test('the knowledge graph counts the edges it could not draw', () => {
    const graph = buildKnowledgeGraph(inspection);
    // actionHints ghost template + path, boundary ghost rule + path.
    expect(graph.droppedEdges ?? 0).toBeGreaterThanOrEqual(4);
  });

  test('`knowledge get` renders the successor with the namespace it resolved into', () => {
    const resolveRef = buildKnowledgeRefResolver(inspection);
    const old = formatEntryFull(inspection.index.get('app.old-way')!, { resolveRef });
    expect(old).toContain('SUPERSEDED by: app.new-way (UNRESOLVED — no registry has this id)');
    expect(old).toContain('See also:\n- fx.rule.one (rule | knowledge — "Rule one")');
    const chainB = formatEntryFull(inspection.index.get('app.chain-b')!, { resolveRef });
    expect(chainB).toContain('SUPERSEDED by: app.chain-c (knowledge — "T app.chain-c")  →  shrk knowledge get app.chain-c');
  });
});
