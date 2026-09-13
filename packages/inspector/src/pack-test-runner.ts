/**
 * Pack test runner.
 *
 * Test case model: `definePackTest({ id, task, expect*Ids?, mustNotIncludeIds?, maxTokens? })`.
 * Test cases live in either:
 *   <packRoot>/sharkcraft/pack-tests.ts
 *   <packRoot>/src/assets/pack-tests.ts
 *
 * The runner:
 *   1. Loads the pack tests via dynamic import (Bun handles TS natively).
 *   2. Inspects the pack once and warms the shared reference registry.
 *   3. For each test case, builds a task packet and checks the expectations —
 *      two classes of assertion, reported separately:
 *        - ranker-SURFACED (`expectKnowledgeIds` / `expectRuleIds` /
 *          `expectTemplateIds` / `expectPipelineIds`): the id is in the packet.
 *          Order-sensitive; an unrelated content edit can flip it.
 *        - registry-EXISTENCE (`expectPlaybookIds` / `expectConstructIds`): the
 *          id is registered. Stable. These were declared but never evaluated
 *          (the packet summary hard-coded both lists to []), so a typo'd id
 *          passed silently.
 *   4. Emits a structured diagnostic report. A surfaced-class miss says whether
 *      the id exists at all (`unknown-id` — can never pass) or merely did not
 *      rank (`not-surfaced`), and names the registry it consulted.
 */

import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { inspectSharkcraft, type ISharkcraftInspection } from './sharkcraft-inspector.ts';
import { buildTaskPacket } from './task-packet.ts';
import { importModuleViaLoader } from '@shrkcrft/core';
import {
  referenceIdExists,
  referenceIdsFor,
  warmReferenceRegistries,
  type ReferenceKind,
} from './reference-registry.ts';

export interface IPackTestCase {
  id: string;
  task: string;
  description?: string;
  // ── Ranker-surfaced (order-sensitive; may flip on unrelated content edits) ──
  expectKnowledgeIds?: ReadonlyArray<string>;
  expectRuleIds?: ReadonlyArray<string>;
  expectTemplateIds?: ReadonlyArray<string>;
  expectPipelineIds?: ReadonlyArray<string>;
  // ── Registry existence (stable) ─────────────────────────────────────────
  expectPlaybookIds?: ReadonlyArray<string>;
  expectConstructIds?: ReadonlyArray<string>;
  mustNotIncludeIds?: ReadonlyArray<string>;
  maxTokens?: number;
}

export function definePackTest<T extends IPackTestCase>(t: T): T {
  return t;
}

export interface IPackTestResult {
  id: string;
  task: string;
  passed: boolean;
  diagnostics: ReadonlyArray<{
    /**
     * `unknown-id` — not registered at all (can never pass); `not-surfaced` —
     * registered but not in the packet; `unexpected-id` — a mustNotInclude id
     * was surfaced.
     */
    code: 'unknown-id' | 'not-surfaced' | 'unexpected-id' | 'token-budget' | 'load-error';
    field?: string;
    /** `surfaced` (in the task packet) or `exists` (registered). */
    assertion?: 'surfaced' | 'exists';
    /** The registry the existence answer came from. */
    consulted?: { kind: string; listVerb: string; size: number };
    expected?: string;
    actual?: string;
    suggestion?: string;
    message: string;
  }>;
  tokenEstimate?: number;
}

export interface IPackTestReport {
  schema: 'sharkcraft.pack-test-report/v1';
  packPath: string;
  testsFile: string | null;
  ran: number;
  passed: number;
  failed: number;
  cases: ReadonlyArray<IPackTestResult>;
}

const TEST_FILE_CANDIDATES = [
  'sharkcraft/pack-tests.ts',
  'src/assets/pack-tests.ts',
  'pack-tests.ts',
];

const LIST_VERBS: Readonly<Record<string, string>> = Object.freeze({
  knowledge: 'shrk knowledge list',
  rule: 'shrk rules list',
  template: 'shrk templates list',
  pipeline: 'shrk pipelines list',
  playbook: 'shrk playbooks list',
  construct: 'shrk constructs list',
});

function findTestsFile(packPath: string): string | null {
  for (const rel of TEST_FILE_CANDIDATES) {
    const abs = join(packPath, rel);
    if (existsSync(abs)) return abs;
  }
  return null;
}

async function loadTestCases(file: string): Promise<IPackTestCase[]> {
  const mod = (await importModuleViaLoader(file)) as {
    default?: ReadonlyArray<IPackTestCase>;
    tests?: ReadonlyArray<IPackTestCase>;
  };
  const list = mod.default ?? mod.tests ?? [];
  return [...list];
}

function unique<T>(arr: ReadonlyArray<T>): T[] {
  return [...new Set(arr)];
}

interface IPackTestPacketSummary {
  knowledgeIds: ReadonlyArray<string>;
  ruleIds: ReadonlyArray<string>;
  templateIds: ReadonlyArray<string>;
  pipelineIds: ReadonlyArray<string>;
  tokenEstimate: number;
}

function summariseTaskPacket(
  inspection: ISharkcraftInspection,
  task: string,
): IPackTestPacketSummary {
  const packet = buildTaskPacket(inspection, task);
  return {
    knowledgeIds: unique(packet.context.sections.flatMap((s) => [...s.entryIds])),
    ruleIds: unique(packet.relevantRules.map((r) => r.id)),
    templateIds: unique(packet.relevantTemplates.map((t) => t.id)),
    pipelineIds: unique(packet.recommendedPipelines.map((p) => p.pipelineId)),
    tokenEstimate: packet.tokenEstimate,
  };
}

function consultedRegistry(
  inspection: ISharkcraftInspection,
  kind: ReferenceKind,
): { kind: string; listVerb: string; size: number } {
  return {
    kind,
    listVerb: LIST_VERBS[kind] ?? `shrk ${kind} list`,
    size: referenceIdsFor(inspection, kind).length,
  };
}

function evaluateCase(
  testCase: IPackTestCase,
  packet: IPackTestPacketSummary,
  inspection: ISharkcraftInspection,
): IPackTestResult {
  const diagnostics: IPackTestResult['diagnostics'][number][] = [];
  const surfaced: Array<{
    field: 'knowledgeIds' | 'ruleIds' | 'templateIds' | 'pipelineIds';
    kind: ReferenceKind;
    expected?: ReadonlyArray<string>;
  }> = [
    { field: 'knowledgeIds', kind: 'knowledge', expected: testCase.expectKnowledgeIds },
    { field: 'ruleIds', kind: 'rule', expected: testCase.expectRuleIds },
    { field: 'templateIds', kind: 'template', expected: testCase.expectTemplateIds },
    { field: 'pipelineIds', kind: 'pipeline', expected: testCase.expectPipelineIds },
  ];
  for (const c of surfaced) {
    if (!c.expected) continue;
    const actualList = packet[c.field];
    for (const id of c.expected) {
      if (actualList.includes(id)) continue;
      const registry = consultedRegistry(inspection, c.kind);
      const exists = referenceIdExists(inspection, c.kind, id);
      diagnostics.push({
        code: exists ? 'not-surfaced' : 'unknown-id',
        field: c.field,
        assertion: 'surfaced',
        consulted: registry,
        expected: id,
        suggestion: exists
          ? `Tune ${id}'s tags / appliesWhen, or reference it from a preset, so the recommender surfaces it for "${testCase.task}".`
          : `Correct the id or ship the ${c.kind} — it is not among the ${registry.size} ids \`${registry.listVerb}\` prints.`,
        message: exists
          ? `Expected ${c.field} to include "${id}" for task "${testCase.task}": it is registered but was not surfaced.`
          : `Expected ${c.field} to include "${id}", but no ${c.kind} "${id}" is registered — this expectation can never pass.`,
      });
    }
  }
  const existence: Array<{
    field: string;
    kind: ReferenceKind;
    expected?: ReadonlyArray<string>;
  }> = [
    { field: 'playbookIds', kind: 'playbook', expected: testCase.expectPlaybookIds },
    { field: 'constructIds', kind: 'construct', expected: testCase.expectConstructIds },
  ];
  for (const c of existence) {
    for (const id of c.expected ?? []) {
      if (referenceIdExists(inspection, c.kind, id)) continue;
      const registry = consultedRegistry(inspection, c.kind);
      diagnostics.push({
        code: 'unknown-id',
        field: c.field,
        assertion: 'exists',
        consulted: registry,
        expected: id,
        suggestion: `Correct the id or ship the ${c.kind} — it is not among the ${registry.size} ids \`${registry.listVerb}\` prints.`,
        message: `Expected ${c.kind} "${id}" to be registered, but it is not.`,
      });
    }
  }
  if (testCase.mustNotIncludeIds && testCase.mustNotIncludeIds.length > 0) {
    const allIds = unique([
      ...packet.knowledgeIds,
      ...packet.ruleIds,
      ...packet.templateIds,
      ...packet.pipelineIds,
    ]);
    for (const id of testCase.mustNotIncludeIds) {
      if (allIds.includes(id)) {
        diagnostics.push({
          code: 'unexpected-id',
          assertion: 'surfaced',
          expected: id,
          actual: id,
          message: `"${id}" should not have been included in the packet for task "${testCase.task}".`,
        });
      }
    }
  }
  if (testCase.maxTokens && packet.tokenEstimate > testCase.maxTokens) {
    diagnostics.push({
      code: 'token-budget',
      message: `Token estimate ${packet.tokenEstimate} exceeds maxTokens=${testCase.maxTokens}.`,
    });
  }
  return {
    id: testCase.id,
    task: testCase.task,
    passed: diagnostics.length === 0,
    diagnostics,
    tokenEstimate: packet.tokenEstimate,
  };
}

export async function runPackTests(input: {
  packPath: string;
  caseId?: string;
  updateSnapshots?: boolean;
}): Promise<IPackTestReport> {
  const { packPath, caseId } = input;
  const testsFile = findTestsFile(packPath);
  if (!testsFile) {
    return {
      schema: 'sharkcraft.pack-test-report/v1',
      packPath,
      testsFile: null,
      ran: 0,
      passed: 0,
      failed: 0,
      cases: [],
    };
  }
  let cases: IPackTestCase[];
  try {
    cases = await loadTestCases(testsFile);
  } catch (e) {
    return {
      schema: 'sharkcraft.pack-test-report/v1',
      packPath,
      testsFile,
      ran: 0,
      passed: 0,
      failed: 1,
      cases: [
        {
          id: '(load)',
          task: '(load)',
          passed: false,
          diagnostics: [
            {
              code: 'load-error',
              message: `Failed to load pack tests from ${testsFile}: ${(e as Error).message}`,
            },
          ],
        },
      ],
    };
  }
  if (caseId) cases = cases.filter((c) => c.id === caseId);
  const results: IPackTestResult[] = [];
  if (cases.length > 0) {
    // One inspection, warmed once: every existence answer comes from the
    // shared reference registry (the playbook / construct kinds are
    // cache-backed and read empty until warmed).
    const inspection = await inspectSharkcraft({ cwd: packPath });
    await warmReferenceRegistries(inspection);
    for (const tc of cases) {
      results.push(evaluateCase(tc, summariseTaskPacket(inspection, tc.task), inspection));
    }
  }
  if (input.updateSnapshots) {
    const snapsDir = join(packPath, 'sharkcraft', 'pack-test-snapshots');
    mkdirSync(snapsDir, { recursive: true });
    for (const r of results) {
      const file = join(snapsDir, `${r.id}.json`);
      writeFileSync(file, JSON.stringify(r, null, 2) + '\n', 'utf8');
    }
  }
  const passed = results.filter((r) => r.passed).length;
  return {
    schema: 'sharkcraft.pack-test-report/v1',
    packPath,
    testsFile,
    ran: results.length,
    passed,
    failed: results.length - passed,
    cases: results,
  };
}

export function renderPackTestReportText(report: IPackTestReport): string {
  const lines: string[] = [];
  lines.push(`=== Pack tests ===`);
  lines.push(`  pack         ${report.packPath}`);
  lines.push(`  tests file   ${report.testsFile ?? '(none)'}`);
  lines.push(`  ran          ${report.ran}`);
  lines.push(`  passed       ${report.passed}`);
  lines.push(`  failed       ${report.failed}`);
  lines.push('');
  for (const c of report.cases) {
    lines.push(`  ${c.passed ? '✓' : '✗'} ${c.id}  ${c.task}`);
    for (const d of c.diagnostics) {
      lines.push(`      - [${d.code}] ${d.message}`);
      if (d.consulted) {
        lines.push(`        consulted: ${d.consulted.kind} registry (${d.consulted.size} ids, \`${d.consulted.listVerb}\`)`);
      }
      if (d.suggestion) lines.push(`        ↳ ${d.suggestion}`);
    }
  }
  return lines.join('\n') + '\n';
}
