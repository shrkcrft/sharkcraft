import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ok } from '@shrkcrft/core';
import { type IAiProvider } from '@shrkcrft/ai';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import {
  smartContextAuditKnowledgeCommand,
  smartContextAuditPipelinesCommand,
} from '../commands/smart-context.command.ts';
import {
  buildKnowledgeAudit,
  type IKnowledgeAuditReport,
} from '../audit/knowledge-audit.ts';
import { enrichKnowledgeAuditWithLlm } from '../audit/knowledge-audit-llm.ts';
import { buildKnowledgeFixPlan } from '../audit/knowledge-fix-plan.ts';
import { enrichKnowledgeFixPlanWithLlm } from '../audit/knowledge-fix-plan-llm.ts';
import {
  buildPipelineAudit,
  buildPipelineFixPlan,
  type IPipelineAuditReport,
} from '../audit/pipeline-audit.ts';
import { enrichPipelineAuditWithLlm } from '../audit/pipeline-audit-llm.ts';
import type { ParsedArgs } from '../command-registry.ts';

process.env.SHRK_DISABLE_AUTO_AI = '1';

const writeOut = process.stdout.write.bind(process.stdout);
const writeErr = process.stderr.write.bind(process.stderr);

async function captureStdio<T>(
  fn: () => T | Promise<T>,
): Promise<{ value: T; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  (process.stdout.write as unknown as (s: string) => boolean) = ((s: string) => {
    stdout += s;
    return true;
  }) as never;
  (process.stderr.write as unknown as (s: string) => boolean) = ((s: string) => {
    stderr += s;
    return true;
  }) as never;
  try {
    const value = await Promise.resolve(fn());
    return { value, stdout, stderr };
  } finally {
    process.stdout.write = writeOut as never;
    process.stderr.write = writeErr as never;
  }
}

function makeArgs(positional: string[], flags: Array<[string, string | boolean]>): ParsedArgs {
  return {
    positional,
    flags: new Map<string, string | boolean>(flags),
    multiFlags: new Map<string, string[]>(),
  };
}

const SAVED = { anthropicKey: process.env.ANTHROPIC_API_KEY };
beforeEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
});
afterEach(() => {
  if (SAVED.anthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = SAVED.anthropicKey;
});

function mkKnowledgeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-audit-knowledge-test-'));
  const dir = join(root, 'sharkcraft');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'audit-knowledge-fixture', version: '0.0.0', type: 'module' }, null, 2),
  );
  // Two entries: one clean, one missing a summary (deterministic finding).
  writeFileSync(
    join(dir, 'knowledge.ts'),
    `export default [
  {
    id: 'demo.clean',
    type: 'rule',
    title: 'Clean entry',
    priority: 'medium',
    scope: ['demo'],
    tags: ['demo'],
    appliesWhen: ['always'],
    summary: 'A short, helpful summary.',
    content: 'Body text describing the rule in detail.',
  },
  {
    id: 'demo.no-summary',
    type: 'rule',
    title: 'Missing summary',
    priority: 'medium',
    scope: ['demo'],
    tags: ['demo'],
    appliesWhen: ['always'],
    content: 'Body text describing the rule in detail.',
  },
];
`,
  );
  writeFileSync(
    join(dir, 'sharkcraft.config.ts'),
    `export default {
  projectName: 'audit-knowledge-fixture',
  knowledgeFiles: ['knowledge.ts'],
};\n`,
  );
  return root;
}

function mkPipelineFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-audit-pipelines-test-'));
  const dir = join(root, 'sharkcraft');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'audit-pipelines-fixture', version: '0.0.0', type: 'module' }, null, 2),
  );
  writeFileSync(
    join(dir, 'pipelines.ts'),
    `export default [
  {
    id: 'demo.write-without-review',
    title: 'Demo write-without-review',
    description: 'Pipeline that writes without a humanReview marker.',
    tags: ['demo'],
    steps: [
      { id: 'do-it', type: 'apply-plan' },
    ],
  },
];
`,
  );
  writeFileSync(
    join(dir, 'sharkcraft.config.ts'),
    `export default {
  projectName: 'audit-pipelines-fixture',
  pipelineFiles: ['pipelines.ts'],
};\n`,
  );
  return root;
}

describe('buildKnowledgeAudit (deterministic orchestrator)', () => {
  let root: string;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('missing-summary entry produces minor verdict + suggested edit', async () => {
    root = mkKnowledgeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const report = buildKnowledgeAudit(inspection, { skipStaleCheck: true });
    const noSummary = report.entries.find((e) => e.entryId === 'demo.no-summary')!;
    expect(noSummary.verdict).toBe('minor');
    expect(noSummary.deterministicFindings.some((f) => f.category === 'knowledge.summary-missing')).toBe(true);
    expect(noSummary.suggestedActions.some((a) => a.kind === 'edit')).toBe(true);
  });

  test('clean entry yields ok or minor', async () => {
    root = mkKnowledgeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const report = buildKnowledgeAudit(inspection, { skipStaleCheck: true });
    const clean = report.entries.find((e) => e.entryId === 'demo.clean')!;
    expect(['ok', 'minor']).toContain(clean.verdict);
  });

  test('--id filter narrows to a single entry', async () => {
    root = mkKnowledgeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const report = buildKnowledgeAudit(inspection, { entryId: 'demo.clean', skipStaleCheck: true });
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]!.entryId).toBe('demo.clean');
  });
});

describe('enrichKnowledgeAuditWithLlm (mocked provider)', () => {
  let root: string;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('merges parsed LLM findings into the report', async () => {
    root = mkKnowledgeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const base = buildKnowledgeAudit(inspection, { skipStaleCheck: true });
    const mock: IAiProvider = {
      id: 'mock',
      name: 'Mock',
      configure() {},
      isReady() {
        return true;
      },
      async send() {
        return ok({
          content: JSON.stringify({
            findings: [
              { severity: 'warn', category: 'content-drift', message: 'References an outdated pattern.', confidence: 0.7 },
            ],
          }),
          model: 'mock',
        });
      },
    };
    const enriched = await enrichKnowledgeAuditWithLlm(base, { provider: mock, inspection });
    expect(enriched.llmEnriched).toBe(true);
    expect(enriched.entries[0]!.llmFindings.length).toBe(1);
    expect(enriched.entries[0]!.llmFindings[0]!.category).toBe('content-drift');
  });
});

describe('buildKnowledgeFixPlan', () => {
  let root: string;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('summary-missing produces a high-confidence fix', async () => {
    root = mkKnowledgeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const report = buildKnowledgeAudit(inspection, { skipStaleCheck: true });
    const plan = buildKnowledgeFixPlan(report);
    const summaryFix = plan.fixes.find((f) => f.findingCategory === 'knowledge.summary-missing');
    expect(summaryFix).toBeDefined();
    expect(summaryFix!.confidence).toBe('high');
    expect(summaryFix!.entryId).toBe('demo.no-summary');
  });

  test('LLM-enriched fix plan adds llmSuggestion when LLM returns matching entry', async () => {
    root = mkKnowledgeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const report = buildKnowledgeAudit(inspection, { skipStaleCheck: true });
    const plan = buildKnowledgeFixPlan(report);
    const mock: IAiProvider = {
      id: 'mock',
      name: 'Mock',
      configure() {},
      isReady() {
        return true;
      },
      async send() {
        return ok({
          content: JSON.stringify({
            suggestions: plan.fixes.map((f) => ({
              findingCategory: f.findingCategory,
              finding: f.finding.slice(0, 80),
              suggestion: `Concrete: ${f.findingCategory}`,
            })),
          }),
          model: 'mock',
        });
      },
    };
    const enriched = await enrichKnowledgeFixPlanWithLlm(plan, { provider: mock, inspection });
    const withSuggestion = enriched.fixes.filter((f) => f.llmSuggestion);
    expect(withSuggestion.length).toBe(plan.fixes.length);
  });
});

describe('smart-context audit-knowledge command', () => {
  let root: string;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('--no-enhance --json produces well-formed report with ai block', async () => {
    root = mkKnowledgeFixture();
    const { value, stdout } = await captureStdio(() =>
      smartContextAuditKnowledgeCommand.run(
        makeArgs([], [
          ['cwd', root],
          ['json', true],
          ['no-enhance', true],
        ]),
      ),
    );
    expect(value).toBe(0);
    const report = JSON.parse(stdout) as IKnowledgeAuditReport;
    expect(report.entries).toHaveLength(2);
    expect(report.ai).toBeDefined();
    expect(report.ai!.enhancementSkipped).toBe(true);
  });
});

describe('buildPipelineAudit (deterministic orchestrator)', () => {
  let root: string;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('apply-plan step without humanReview produces stale verdict', async () => {
    root = mkPipelineFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const report = buildPipelineAudit(inspection);
    expect(report.pipelines).toHaveLength(1);
    const p = report.pipelines[0]!;
    expect(p.verdict).toBe('stale');
    expect(p.deterministicFindings.some((f) => f.category === 'write-without-review')).toBe(true);
  });
});

describe('buildPipelineFixPlan', () => {
  let root: string;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('write-without-review yields a medium-confidence fix targeting the step', async () => {
    root = mkPipelineFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const report = buildPipelineAudit(inspection);
    const plan = buildPipelineFixPlan(report);
    const fix = plan.fixes.find((f) => f.findingCategory === 'write-without-review');
    expect(fix).toBeDefined();
    expect(fix!.confidence).toBe('medium');
    expect(fix!.stepId).toBe('do-it');
    expect(fix!.agentPrompt).toContain('humanReview');
  });
});

describe('enrichPipelineAuditWithLlm (mocked provider)', () => {
  let root: string;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('merges LLM findings into the report', async () => {
    root = mkPipelineFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const base = buildPipelineAudit(inspection);
    const mock: IAiProvider = {
      id: 'mock',
      name: 'Mock',
      configure() {},
      isReady() {
        return true;
      },
      async send() {
        return ok({
          content: JSON.stringify({
            findings: [
              { severity: 'info', category: 'step-order-bug', message: 'Steps look reversed.', confidence: 0.6 },
            ],
          }),
          model: 'mock',
        });
      },
    };
    const enriched = await enrichPipelineAuditWithLlm(base, { provider: mock, inspection });
    expect(enriched.llmEnriched).toBe(true);
    expect(enriched.pipelines[0]!.llmFindings).toHaveLength(1);
    expect(enriched.pipelines[0]!.llmFindings[0]!.category).toBe('step-order-bug');
  });
});

describe('smart-context audit-pipelines command', () => {
  let root: string;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('--no-enhance --json --fix-plan produces both report and plan', async () => {
    root = mkPipelineFixture();
    const { value, stdout } = await captureStdio(() =>
      smartContextAuditPipelinesCommand.run(
        makeArgs([], [
          ['cwd', root],
          ['json', true],
          ['no-enhance', true],
          ['fix-plan', true],
        ]),
      ),
    );
    expect(value).toBe(0);
    const parsed = JSON.parse(stdout) as { report: IPipelineAuditReport; fixPlan: { fixes: unknown[] } };
    expect(parsed.report.pipelines).toHaveLength(1);
    expect(parsed.fixPlan).toBeDefined();
    expect(parsed.fixPlan.fixes.length).toBeGreaterThan(0);
  });
});
