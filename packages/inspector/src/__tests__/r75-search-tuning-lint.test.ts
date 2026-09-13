/**
 * r75 — THE search-tuning lint (spec 1.3#5): one lint, two renderers.
 *
 * `search tuning doctor` printed "No issues." and exited 0 over duplicate
 * trigger sets, triggers no tokenizer can produce, a typo'd kind and a total
 * cap that silently discarded composed tuning. Real loaders only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspectSharkcraft, type ISharkcraftInspection } from '../sharkcraft-inspector.ts';
import { lintSearchTuning } from '../search-tuning-lint.ts';
import { buildSelfConfigDoctorReportV2 } from '../self-config-doctor-v2.ts';
import { loadSearchTuning, tuningBoostFor } from '../search-tuning-registry.ts';
import { explainSearchTuning } from '../search-tuning-explain.ts';
import type { ISearchTuningLintReport } from '../i-search-tuning-lint-report.ts';

const TIMEOUT_MS = 60_000;
let root = '';
let insp: ISharkcraftInspection;
let lint: ISearchTuningLintReport;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'shrk-r75-tuninglint-'));
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
    'sharkcraft/sharkcraft.config.ts': `export default { projectName: 'fx', knowledgeFiles: ['knowledge.ts'], ruleFiles: ['rules.ts'] };\n`,
    'sharkcraft/knowledge.ts': `export default [
  { id: 'alpha.entry', title: 'Alpha entry', type: 'architecture', priority: 'high', tags: ['alpha'], content: 'Alpha content about widgets.' },
  { id: 'gamma.entry', title: 'Gamma entry', type: 'architecture', priority: 'low', tags: ['captag'], content: 'Gamma content about widgets.' },
];
`,
    'sharkcraft/rules.ts': `export default [{ id: 'fx.rule', title: 'Rule', type: 'rule', priority: 'high', scope: [], tags: [], appliesWhen: [], content: 'A rule about widgets.' }];\n`,
    'sharkcraft/search-tuning.ts': `export default [
  { id: 't.dup', taskHints: [
    { whenTokens: ['alpha'], boostIds: { 'knowledge:alpha.entry': 2 } },
    { whenTokens: ['alpha'], boostIds: { 'knowledge:alpha.entry': 1 } },
  ] },
  { id: 't.deadtokens', taskHints: [
    { whenTokens: ['x'], boostIds: { 'knowledge:alpha.entry': 1 } },
    { whenTokens: ['two words'], boostIds: { 'knowledge:alpha.entry': 1 } },
  ] },
  { id: 't.kindtypo', appliesToKinds: ['templat'], boostTags: { alpha: 1 } },
  { id: 't.excluded', appliesToKinds: ['template'], boostIds: { 'rule:fx.rule': 2 } },
  { id: 't.cap', boostTags: { captag: 5 }, boostIds: { 'knowledge:gamma.entry': 5 }, taskHints: [{ whenTokens: ['gamma'], boostIds: { 'knowledge:gamma.entry': 5 } }] },
  { id: 't.source', boostSources: { packz: 1 } },
];
`,
  };
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  insp = await inspectSharkcraft({ cwd: root });
  lint = await lintSearchTuning(insp);
}, TIMEOUT_MS);

afterAll(() => rmSync(root, { recursive: true, force: true }));

const codes = (code: string): string[] => lint.issues.filter((i) => i.code === code).map((i) => i.tuningId);

describe('r75 search-tuning lint', () => {
  test('each defect is named once', () => {
    expect(codes('duplicate-trigger')).toEqual(['t.dup']);
    expect(codes('unreachable-trigger')).toEqual(['t.deadtokens', 't.deadtokens']);
    expect(codes('unknown-kind')).toEqual(['t.kindtypo']);
    expect(codes('boost-excluded-by-kind')).toEqual(['t.excluded']);
    expect(codes('unknown-source')).toEqual(['t.source']);
    const cap = lint.issues.filter((i) => i.code === 'cap-discards');
    expect(cap).toHaveLength(1);
    expect(cap[0]).toMatchObject({ severity: 'info', docId: 'knowledge:gamma.entry', discarded: 5, tuningId: 't.cap' });
  });

  test('dead units are coverage shortfalls, named', () => {
    const hints = lint.coverage.find((c) => c.unit === 'task hints')!;
    expect(hints.examined).toBe(hints.expected - 2);
    expect(hints.unexamined).toEqual(['t.deadtokens task hint #1 [x]', 't.deadtokens task hint #2 [two words]']);
    const keys = lint.coverage.find((c) => c.unit === 'boost keys')!;
    expect(keys.unexamined).toContain('rule:fx.rule (excluded by appliesToKinds)');
    expect(lint.deadUnits.length).toBeGreaterThanOrEqual(3);
  });

  test('the same findings in the self-config doctor (one lint, two renderers)', async () => {
    const report = await buildSelfConfigDoctorReportV2(insp);
    const doctor = report.findings
      .filter((f) => f.code.startsWith('search-tuning-') && !f.code.endsWith('clamped'))
      .map((f) => `${f.code}|${f.sourceId}`)
      .sort();
    const fromLint = [...new Set(lint.issues.map((i) => `search-tuning-${i.code}|${i.tuningId}`))].sort();
    expect([...new Set(doctor)].sort()).toEqual(fromLint);
    expect(report.coverage).toEqual(expect.arrayContaining(lint.coverage as never[]));
  });

  test('the total cap is reported, not silent', async () => {
    const { entries } = await loadSearchTuning(insp);
    const boost = tuningBoostFor({ id: 'knowledge:gamma.entry', kind: 'knowledge', tags: ['captag'], source: 'local' }, ['gamma'], entries);
    expect(boost.delta).toBe(10);
    expect(boost.capped).toEqual({ raw: 15, applied: 10 });
    expect(boost.reasons.some((r) => r.startsWith('tuning-cap: raw +15 -> +10'))).toBe(true);
    const ex = await explainSearchTuning(insp, 'gamma widgets', { topN: 10 });
    expect(ex.cappedBoosts).toContainEqual({ tuningId: '(combined)', key: 'total', docId: 'knowledge:gamma.entry', original: 15, clamped: 10 });
  });
});
