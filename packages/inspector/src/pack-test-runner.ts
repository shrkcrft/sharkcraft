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
 *   2. For each test case, builds a task packet against an isolated inspection.
 *   3. Validates the packet contains every `expect*Ids` and none of the
 *      `mustNotIncludeIds`, optionally capping the token budget.
 *   4. Emits a structured diagnostic report.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { inspectSharkcraft } from './sharkcraft-inspector.ts';
import { buildTaskPacket } from './task-packet.ts';
import { importModuleViaLoader } from '@shrkcrft/core';

export interface IPackTestCase {
  id: string;
  task: string;
  description?: string;
  expectKnowledgeIds?: ReadonlyArray<string>;
  expectRuleIds?: ReadonlyArray<string>;
  expectTemplateIds?: ReadonlyArray<string>;
  expectPipelineIds?: ReadonlyArray<string>;
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
    code: 'missing-id' | 'unexpected-id' | 'token-budget' | 'load-error';
    field?: string;
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
  playbookIds: ReadonlyArray<string>;
  constructIds: ReadonlyArray<string>;
  tokenEstimate: number;
}

async function summariseTaskPacket(
  packPath: string,
  task: string,
): Promise<IPackTestPacketSummary> {
  const inspection = await inspectSharkcraft({ cwd: packPath });
  const packet = buildTaskPacket(inspection, task);
  const knowledgeIds = unique(
    packet.context.sections.flatMap((s) => [...s.entryIds]),
  );
  const ruleIds = unique(packet.relevantRules.map((r) => r.id));
  const templateIds = unique(packet.relevantTemplates.map((t) => t.id));
  const pipelineIds = unique(packet.recommendedPipelines.map((p) => p.pipelineId));
  return {
    knowledgeIds,
    ruleIds,
    templateIds,
    pipelineIds,
    playbookIds: [],
    constructIds: [],
    tokenEstimate: packet.tokenEstimate,
  };
}

function evaluateCase(
  testCase: IPackTestCase,
  packet: IPackTestPacketSummary,
): IPackTestResult {
  const diagnostics: IPackTestResult['diagnostics'][number][] = [];
  const checks: Array<{
    field: keyof IPackTestPacketSummary;
    expected?: ReadonlyArray<string>;
  }> = [
    { field: 'knowledgeIds', expected: testCase.expectKnowledgeIds },
    { field: 'ruleIds', expected: testCase.expectRuleIds },
    { field: 'templateIds', expected: testCase.expectTemplateIds },
    { field: 'pipelineIds', expected: testCase.expectPipelineIds },
  ];
  for (const c of checks) {
    if (!c.expected) continue;
    const actualList = packet[c.field] as ReadonlyArray<string>;
    for (const id of c.expected) {
      if (!actualList.includes(id)) {
        diagnostics.push({
          code: 'missing-id',
          field: c.field as string,
          expected: id,
          suggestion: `Add ${id} to the pack's ${c.field as string} or to the recommender for "${testCase.task}".`,
          message: `Expected ${c.field as string} to include "${id}" for task "${testCase.task}", but it did not.`,
        });
      }
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
  for (const tc of cases) {
    const summary = await summariseTaskPacket(packPath, tc.task);
    results.push(evaluateCase(tc, summary));
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
      if (d.suggestion) lines.push(`        ↳ ${d.suggestion}`);
    }
  }
  return lines.join('\n') + '\n';
}
