/**
 * r78 — a knowledge entry the LOADER refused is never a clean pass (round 15
 * follow-up, F3), in-process over real loaders.
 *
 * The round-12 rejection channel carried a refused knowledge / rule / path /
 * docs entry to `self-config doctor` and `knowledge list` only: the stale-check
 * swept the survivors and printed "N of N entries verified ✓" at exit 0,
 * `quality` passed and `shrk doctor` said "Ready ✓" — over a corpus none of them
 * had fully read. THE census (fixtures/r76-census, one invalid entry per slot,
 * plus its Markdown knowledge file — F12) runs through:
 *
 *   - the stale report (`rejectedEntries[]`, never narrowed by a changeset),
 *     read through the ONE list `knowledgeRejectedEntries`;
 *   - the gate: 2 by default, 1 under `--fail-on invalid`, and no valve
 *     (`--min-referenced`, `--allow-empty`) accepts it;
 *   - `quality`'s knowledge gate and `runDoctor` (a check each, NOT VERIFIED).
 *
 * Also: F10 (`required` is a boolean — TS and Markdown, one predicate) and F11
 * (THE knowledge slots ≡ the slots whose kind is a knowledge kind).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CONTRIBUTION_FILE_KEYS } from '@shrkcrft/plugin-api';
import type { ContributionKind } from '../contribution-kind.ts';
import { describeInspectionDiscovery } from '../inspection-discovery.ts';
import { isKnowledgeContributionSlot, KNOWLEDGE_CONTRIBUTION_SLOTS } from '../knowledge-contribution-slots.ts';
import { KNOWLEDGE_CONTRIBUTION_KINDS, knowledgeRejectedEntries, REJECTED_AT_LOAD } from '../knowledge-entry-rejections.ts';
import { buildKnowledgeStaleReport, ReferenceCheckOutcome } from '../knowledge-stale.ts';
import {
  evaluateKnowledgeStaleGate,
  KNOWLEDGE_REJECTED_RULE_ID,
  knowledgeStaleGateInput,
  settleKnowledgeStaleGate,
} from '../knowledge-stale-gate.ts';
import type { IKnowledgeStaleGateFlags } from '../knowledge-stale-gate-flags.ts';
import { knowledgeStaleQualityGate } from '../knowledge-stale-quality-gate.ts';
import { contributionKindForSlot } from '../pack-contributions-inventory.ts';
import { warmReferenceRegistries } from '../reference-registry.ts';
import { inspectSharkcraft, runDoctor, type ISharkcraftInspection } from '../sharkcraft-inspector.ts';
import { unverifiableFileRemedy } from '../knowledge-unverifiable-remedy.ts';
import { KnowledgeUnverifiableReason } from '../knowledge-unverifiable-reason.ts';
import { validateContributionFile } from '../validate-contribution-file.ts';
import type { IKnowledgeStaleReport } from '../knowledge-stale.ts';

const TIMEOUT_MS = 180_000;
const FIXTURE = join(import.meta.dir, 'fixtures', 'r76-census');
const PACK = '@r76/census';

interface ICensusFile {
  readonly file: string;
  readonly kind: string;
  readonly entryId: string | null;
  readonly field: string;
}
const CENSUS = JSON.parse(readFileSync(join(FIXTURE, 'census.json'), 'utf8')) as {
  readonly slots: Readonly<Record<string, ICensusFile>>;
  readonly markdown?: { readonly files: readonly ICensusFile[] };
};
/** Every census file whose invalid entry a KNOWLEDGE loader refuses — the Markdown one included. */
const KNOWLEDGE_FILES: readonly ICensusFile[] = [...Object.values(CENSUS.slots), ...(CENSUS.markdown?.files ?? [])].filter(
  (c) => KNOWLEDGE_CONTRIBUTION_KINDS.includes(c.kind as ContributionKind),
);
const EXPECTED_IDS = KNOWLEDGE_FILES.map((c) => c.entryId!).sort();

const roots: string[] = [];
let census = '';
let inspection: ISharkcraftInspection;

function tree(prefix: string, files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

/** Settle the ONE gate over `report` with explicit verb flags (no config block). */
function settle(i: ISharkcraftInspection, report: IKnowledgeStaleReport, flags: IKnowledgeStaleGateFlags) {
  const gate = evaluateKnowledgeStaleGate(
    report,
    knowledgeStaleGateInput({ flags, knowledgeCheck: undefined, discovery: describeInspectionDiscovery(i), scoped: false }),
  );
  return { gate, settled: settleKnowledgeStaleGate(gate) };
}

beforeAll(async () => {
  census = mkdtempSync(join(tmpdir(), 'shrk-r78-refused-census-'));
  roots.push(census);
  cpSync(join(FIXTURE, 'consumer'), census, { recursive: true });
  cpSync(join(FIXTURE, 'pack'), join(census, 'node_modules', '@r76', 'census'), { recursive: true });
  inspection = await inspectSharkcraft({ cwd: census });
  await warmReferenceRegistries(inspection);
}, TIMEOUT_MS);

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe('r78 F3 — the census: every refused knowledge-family entry reaches the stale report', () => {
  test('rejectedEntries names each one (the Markdown entry too) — the ONE list, with file, pack and reasons', () => {
    expect(EXPECTED_IDS).toContain('cz.kmd-bad');
    const report = buildKnowledgeStaleReport(inspection);
    expect(report.rejectedEntries.map((r) => r.entryId).sort()).toEqual(EXPECTED_IDS);
    // One authority: the report reads the channel's list, nothing re-derived.
    expect(report.rejectedEntries).toEqual(knowledgeRejectedEntries(inspection));
    for (const c of KNOWLEDGE_FILES) {
      const r = report.rejectedEntries.find((x) => x.entryId === c.entryId)!;
      expect({
        id: c.entryId,
        source: r.source,
        pack: r.pack,
        message: r.message.startsWith(`${REJECTED_AT_LOAD}: ${c.field}:`),
      }).toEqual({ id: c.entryId, source: `node_modules/@r76/census/${c.file}`, pack: PACK, message: true });
    }
    // Never in scope, never an entry verdict: nothing they claim was read.
    expect(report.entryVerdicts.some((v) => EXPECTED_IDS.includes(v.entryId))).toBe(false);
  });

  test('a changeset never narrows them: a scoped run still carries every refused entry', () => {
    const scoped = buildKnowledgeStaleReport(inspection, { changedFiles: ['src/a.ts'] });
    expect(scoped.rejectedEntries.map((r) => r.entryId).sort()).toEqual(EXPECTED_IDS);
  });

  test('the gate: 2 by default (a skipped rule), 1 under --fail-on invalid, and no valve accepts it', () => {
    const report = buildKnowledgeStaleReport(inspection);
    const base = settle(inspection, report, {});
    expect(base.settled.exit).toBe(2);
    const rule = base.gate.rules.find((r) => r.id === KNOWLEDGE_REJECTED_RULE_ID)!;
    expect(rule.status).toBe('skipped');
    expect(rule.coverage).toMatchObject({ unit: 'knowledge entries', expected: EXPECTED_IDS.length, examined: 0 });
    expect(base.gate.notVerifiedLead).toContain(`${EXPECTED_IDS.length} knowledge entries were rejected at load and never checked`);
    expect(base.settled.shortfalls.some((s) => s.startsWith(`${KNOWLEDGE_REJECTED_RULE_ID}:`))).toBe(true);

    const failing = settle(inspection, report, { failOn: ['invalid'] });
    expect(failing.settled.exit).toBe(1);
    expect(failing.gate.reasons).toContain(`${EXPECTED_IDS.length} knowledge entries rejected at load (--fail-on=invalid)`);
    const failedRule = failing.gate.rules.find((r) => r.id === KNOWLEDGE_REJECTED_RULE_ID)!;
    expect(failedRule.status).toBe('failed');
    expect(failedRule.violations.map((v) => v.id).sort()).toEqual(EXPECTED_IDS);

    // `--min-referenced 0` accepts the unverifiable remainder — never a refused entry.
    const floor = settle(inspection, report, { minReferenced: { ratio: 0, acceptedBy: '--min-referenced 0' } });
    expect(floor.settled.exit).toBe(2);
    expect(floor.settled.shortfalls.some((s) => s.startsWith(`${KNOWLEDGE_REJECTED_RULE_ID}:`))).toBe(true);
  });

  test("quality's knowledge gate and runDoctor name each one and never pass", async () => {
    const q = await knowledgeStaleQualityGate(inspection);
    expect(q.executed).toBe(true);
    expect(q.data?.['settledExit']).toBe(2);
    expect(q.notes[0]).toContain(`rejected at load ${EXPECTED_IDS.length}`);
    expect(q.notes.some((n) => n.startsWith('cz.kmd-bad (node_modules/@r76/census/knowledge.md, pack @r76/census) — rejected at load'))).toBe(true);
    const data = q.data?.['rejectedEntries'] as readonly { entryId?: string }[];
    expect(data.map((r) => r.entryId).sort()).toEqual(EXPECTED_IDS);

    const doctor = runDoctor(inspection);
    const checks = doctor.checks.filter((c) => c.code === 'knowledge-entry-rejected');
    expect(checks.map((c) => c.message.split(' ')[0]).sort()).toEqual(EXPECTED_IDS);
    expect(checks.every((c) => c.message.includes(REJECTED_AT_LOAD))).toBe(true);
    const cov = (doctor.coverage ?? []).find((c) => c.unit === 'knowledge entries');
    expect(cov).toMatchObject({ expected: inspection.knowledgeEntries.length + EXPECTED_IDS.length, examined: inspection.knowledgeEntries.length });
  });
});

describe('r78 F3 — local corpora', () => {
  const ENTRY =
    "{ id: 'k.ok', title: 'Ok', type: 'technical', priority: 'low', scope: [], tags: [], appliesWhen: [], content: 'x', references: [{ kind: 'file', path: 'src/a.ts' }] }";

  test(
    'every declared entry refused: the empty scope names why, and --allow-empty never accepts it',
    async () => {
      const root = tree('shrk-r78-refused-all-', {
        'package.json': JSON.stringify({ name: 'r78-refused', version: '0.0.0', private: true }),
        'src/a.ts': 'export const a = 1;\n',
        'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'r78', knowledgeFiles: ['knowledge.ts'] };\n",
        'sharkcraft/knowledge.ts':
          "export default [{ id: 'k.bad', title: 'Bad', type: 'technical', priority: 'low', scope: [], tags: [], appliesWhen: [] }];\n",
      });
      const i = await inspectSharkcraft({ cwd: root });
      await warmReferenceRegistries(i);
      const report = buildKnowledgeStaleReport(i);
      expect(report.entries).toBe(0);
      expect(report.rejectedEntries.map((r) => [r.entryId, r.source, r.at])).toEqual([['k.bad', 'sharkcraft/knowledge.ts', 'default[0]']]);
      const base = settle(i, report, {});
      expect(base.settled.exit).toBe(2);
      expect(base.gate.runCoverage.reason).toBe('every declared knowledge entry (1) was rejected at load, so none was checked');
      const allowed = settle(i, report, { emptyAcceptance: { acceptedBy: '--allow-empty' } });
      expect(allowed.settled.exit).toBe(2);
      // The quality gate is not a deliberate "empty corpus" skip over it.
      const q = await knowledgeStaleQualityGate(i);
      expect(q.data?.['skip']).toBeUndefined();
      expect(q.data?.['settledExit']).toBe(2);
    },
    TIMEOUT_MS,
  );

  test(
    'a duplicate-id rejection is NOT a refused row: the id it collided with IS checked (the seam precedent)',
    async () => {
      const root = tree('shrk-r78-refused-dup-', {
        'package.json': JSON.stringify({ name: 'r78-dup', version: '0.0.0', private: true }),
        'src/a.ts': 'export const a = 1;\n',
        'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'r78', knowledgeFiles: ['knowledge.ts'] };\n",
        'sharkcraft/knowledge.ts': `export const one = ${ENTRY};\nexport const two = { ...${ENTRY}, title: 'Two' };\n`,
      });
      const i = await inspectSharkcraft({ cwd: root });
      await warmReferenceRegistries(i);
      const channel = (i.loaderDiagnostics ?? []).flatMap((d) => d.rejected ?? []);
      expect(channel.map((r) => [r.entryId, r.cause])).toEqual([['k.ok', 'duplicate-id']]);
      const report = buildKnowledgeStaleReport(i);
      expect(report.rejectedEntries).toEqual([]);
      expect(settle(i, report, {}).settled.exit).toBe(0);
    },
    TIMEOUT_MS,
  );

  test(
    'a label names ONE refused declaration: an id a loaded entry or an earlier refused one holds is qualified by its site, and doctor check ids stay unique',
    async () => {
      const bad = (id: string, title: string): string =>
        `{ id: '${id}', title: '${title}', type: 'technical', priority: 'low', scope: [], tags: [], appliesWhen: [] }`;
      const root = tree('shrk-r78-refused-same-id-', {
        'package.json': JSON.stringify({ name: 'r78-same-id', version: '0.0.0', private: true }),
        'src/a.ts': 'export const a = 1;\n',
        'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'r78', knowledgeFiles: ['knowledge.ts', 'more.ts'] };\n",
        'sharkcraft/knowledge.ts': `export default [${ENTRY}, ${bad('k.bad', 'Bad')}];\n`,
        // A second refused `k.bad`, and a refused `k.ok` — the id the loaded entry holds.
        'sharkcraft/more.ts': `export default [${bad('k.bad', 'Bad2')}, ${bad('k.ok', 'Shadow')}];\n`,
      });
      const i = await inspectSharkcraft({ cwd: root });
      await warmReferenceRegistries(i);
      const refused = knowledgeRejectedEntries(i);
      expect(refused.map((r) => [r.entryId, r.label])).toEqual([
        ['k.bad', 'k.bad'],
        ['k.bad', 'k.bad (sharkcraft/more.ts default[0])'],
        ['k.ok', 'k.ok (sharkcraft/more.ts default[1])'],
      ]);
      const doctor = runDoctor(i);
      const ids = doctor.checks.filter((c) => c.code === 'knowledge-entry-rejected').map((c) => c.id);
      expect(ids.length).toBe(3);
      expect(new Set(ids).size).toBe(3);
      // The message names the id and the declaration site once each.
      expect(doctor.checks.filter((c) => c.code === 'knowledge-entry-rejected').map((c) => c.message.split(':')[0])).toEqual([
        'k.bad in sharkcraft/knowledge.ts (default[1])',
        'k.bad in sharkcraft/more.ts (default[0])',
        'k.ok in sharkcraft/more.ts (default[1])',
      ]);
      const cov = (doctor.coverage ?? []).find((c) => c.unit === 'knowledge entries');
      expect(new Set(cov?.unexamined ?? []).size).toBe(3);
    },
    TIMEOUT_MS,
  );
});

describe('r78 F10 — `required` is a boolean, one predicate for TypeScript and Markdown', () => {
  test(
    "required: 'yes' (TS) and required: yes (Markdown) are INVALID rows and invalid-reference issues; required: true is checked",
    async () => {
      const root = tree('shrk-r78-required-', {
        'package.json': JSON.stringify({ name: 'r78-required', version: '0.0.0', private: true }),
        'src/a.ts': 'export const a = 1;\n',
        'sharkcraft/sharkcraft.config.ts':
          "export default { projectName: 'r78', knowledgeFiles: ['knowledge.ts', 'req.md', 'ok.md'] };\n",
        'sharkcraft/knowledge.ts':
          "export default [{ id: 'k.req', title: 'Req', type: 'technical', priority: 'low', scope: [], tags: [], appliesWhen: [], content: 'x', references: [{ kind: 'file', path: 'src/a.ts', required: 'yes' }] }];\n",
        'sharkcraft/req.md': '---\nid: doc.req\ntitle: Req\nreferences:\n  - kind: file\n    path: src/a.ts\n    required: yes\n---\n# Req\n',
        'sharkcraft/ok.md': '---\nid: doc.ok\ntitle: Ok\nreferences:\n  - kind: file\n    path: src/a.ts\n    required: true\n---\n# Ok\n',
      });
      const i = await inspectSharkcraft({ cwd: root });
      await warmReferenceRegistries(i);
      const want = 'has a non-boolean `required` (got "yes") — write required: true or required: false';
      const issues = i.validationIssues.filter((v) => v.code === 'invalid-reference');
      expect(issues.map((v) => [v.entryId, v.severity, v.message.includes(want)]).sort()).toEqual([
        ['doc.req', 'error', true],
        ['k.req', 'error', true],
      ]);
      const report = buildKnowledgeStaleReport(i);
      const row = (id: string) => report.referenceChecks.find((c) => c.entryId === id)!;
      expect(row('k.req').outcome).toBe(ReferenceCheckOutcome.Invalid);
      expect(row('doc.req').outcome).toBe(ReferenceCheckOutcome.Invalid);
      expect(row('k.req').message).toBe(row('doc.req').message);
      expect(row('doc.ok').outcome).toBe(ReferenceCheckOutcome.Ok);
      expect(row('doc.ok').reference.required).toBe(true);
      // Its only reference is malformed, so the entry is unverifiable — but it
      // DECLARES a references: list: the remedy never says "add" one.
      const verdict = report.entryVerdicts.find((v) => v.entryId === 'doc.req')!;
      expect(verdict.reason).toBe(KnowledgeUnverifiableReason.OnlyUnverifiableReferences);
      const remedy = unverifiableFileRemedy(verdict) ?? '';
      expect(remedy).toContain('declares nothing checkable');
      expect(remedy).not.toContain('add a references: frontmatter list');
    },
    TIMEOUT_MS,
  );
});

describe('r78 F11 — THE knowledge slots', () => {
  test('a slot feeds the knowledge loaders iff its contribution kind is a knowledge kind (two-way)', () => {
    for (const slot of CONTRIBUTION_FILE_KEYS) {
      const kind = contributionKindForSlot(slot);
      expect({ slot, knowledge: isKnowledgeContributionSlot(slot) }).toEqual({
        slot,
        knowledge: kind !== undefined && KNOWLEDGE_CONTRIBUTION_KINDS.includes(kind),
      });
    }
    expect([...KNOWLEDGE_CONTRIBUTION_SLOTS].every((s) => (CONTRIBUTION_FILE_KEYS as readonly string[]).includes(s))).toBe(true);
  });

  test('a knowledge-slot file no knowledge loader reads is unvalidated — whatever its slot says', async () => {
    const root = tree('shrk-r78-slot-', { 'notes.txt': 'plain text\n', 'guide.md': '---\nid: p.guide\ntitle: Guide\n---\n# Guide\n' });
    expect((await validateContributionFile('knowledgeFiles', join(root, 'notes.txt'))).unvalidated).toBe(true);
    const md = await validateContributionFile('docsFiles', join(root, 'guide.md'));
    expect({ unvalidated: md.unvalidated, accepted: md.acceptedIds }).toEqual({ unvalidated: undefined, accepted: ['p.guide'] });
  });
});
