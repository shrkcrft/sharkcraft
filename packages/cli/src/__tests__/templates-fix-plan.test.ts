import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { smartContextAuditTemplatesCommand } from '../commands/smart-context.command.ts';
import { buildFixPlan, type ITemplateFixPlan } from '../audit/templates-fix-plan.ts';
import {
  buildTemplateAudit,
  type ITemplateAuditReport,
} from '../audit/templates-audit.ts';
import { enrichAuditWithLlm } from '../audit/templates-audit-llm.ts';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import { type IAiProvider } from '@shrkcrft/ai';
import { ok } from '@shrkcrft/core';
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

interface IFixturePieces {
  withWarning?: boolean;
  withError?: boolean;
  withUnresolvedRelated?: boolean;
  withMissingDescription?: boolean;
}

function makeFixtureWorkspace(pieces: IFixturePieces = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-fixplan-test-'));
  const sharkcraftDir = join(root, 'sharkcraft');
  mkdirSync(sharkcraftDir, { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'fixplan-fixture', version: '0.0.0', type: 'module' }, null, 2),
  );

  const parts: string[] = [];
  parts.push(`{
  id: 'baseline.example',
  name: 'Baseline example',
  description: 'Clean template, exists to keep the registry non-empty.',
  tags: ['demo'],
  scope: ['typescript'],
  appliesWhen: ['create-feature'],
  variables: [
    {
      name: 'description',
      required: true,
      description: 'One-line description.',
      examples: ['Adds the feature.'],
    },
  ],
  targetPath: 'packages/example/baseline.ts',
  content: 'export const x = 1;',
}`);

  if (pieces.withWarning) {
    parts.push(`{
  id: 'undeclared.example',
  name: 'Undeclared example',
  description: 'Has an undeclared placeholder.',
  tags: ['demo'],
  scope: ['typescript'],
  appliesWhen: ['create-feature'],
  variables: [],
  targetPath: 'packages/example/undeclared.ts',
  content: 'export const x = {{undeclared}};',
}`);
  }

  if (pieces.withError) {
    parts.push(`{
  id: 'unsafe.example',
  name: 'Unsafe example',
  description: 'Has unsafe targetPath.',
  tags: ['demo'],
  scope: ['typescript'],
  appliesWhen: ['create-feature'],
  variables: [],
  targetPath: '/etc/passwd',
  content: 'irrelevant',
}`);
  }

  if (pieces.withUnresolvedRelated) {
    parts.push(`{
  id: 'related.example',
  name: 'Related example',
  description: 'References a related id that does not resolve.',
  tags: ['demo'],
  scope: ['typescript'],
  appliesWhen: ['create-feature'],
  variables: [
    {
      name: 'description',
      required: true,
      description: 'desc',
      examples: ['x'],
    },
  ],
  targetPath: 'packages/example/related.ts',
  content: 'export const r = 1;',
  related: ['nonexistent.knowledge.entry'],
}`);
  }

  if (pieces.withMissingDescription) {
    parts.push(`{
  id: 'no-desc.example',
  name: 'No description example',
  description: '',
  tags: ['demo'],
  scope: ['typescript'],
  appliesWhen: ['create-feature'],
  variables: [
    {
      name: 'description',
      required: true,
      description: 'desc',
      examples: ['x'],
    },
  ],
  targetPath: 'packages/example/nodesc.ts',
  content: 'export const x = 1;',
}`);
  }

  writeFileSync(join(sharkcraftDir, 'templates.ts'), `export default [\n${parts.join(',\n')}\n];\n`);
  writeFileSync(
    join(sharkcraftDir, 'sharkcraft.config.ts'),
    `export default {
  projectName: 'fixplan-fixture',
  templateFiles: ['templates.ts'],
};\n`,
  );
  return root;
}

describe('buildFixPlan — per-category dispatch', () => {
  let root: string;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('unsafe-target is skipped with a security reason', async () => {
    root = makeFixtureWorkspace({ withError: true });
    const inspection = await inspectSharkcraft({ cwd: root });
    const report = buildTemplateAudit(inspection);
    const plan = buildFixPlan(report);
    expect(plan.skipped.length).toBeGreaterThan(0);
    expect(plan.skipped.some((s) => s.findingCategory === 'unsafe-target')).toBe(true);
    expect(plan.fixes.every((f) => f.findingCategory !== 'unsafe-target')).toBe(true);
  });

  test('undeclared-var produces a medium-confidence fix mentioning the placeholder', async () => {
    root = makeFixtureWorkspace({ withWarning: true });
    const inspection = await inspectSharkcraft({ cwd: root });
    const report = buildTemplateAudit(inspection);
    const plan = buildFixPlan(report);
    const fix = plan.fixes.find((f) => f.findingCategory === 'undeclared-var');
    expect(fix).toBeDefined();
    expect(fix!.confidence).toBe('medium');
    expect(fix!.agentPrompt).toContain('undeclared');
    expect(fix!.templateId).toBe('undeclared.example');
  });

  test('related-id-unresolved produces a high-confidence fix naming the bad id', async () => {
    root = makeFixtureWorkspace({ withUnresolvedRelated: true });
    const inspection = await inspectSharkcraft({ cwd: root });
    const report = buildTemplateAudit(inspection);
    const plan = buildFixPlan(report);
    const fix = plan.fixes.find((f) => f.findingCategory === 'related-id-unresolved');
    expect(fix).toBeDefined();
    expect(fix!.confidence).toBe('high');
    expect(fix!.agentPrompt).toContain('nonexistent.knowledge.entry');
  });

  test('missing-description produces a high-confidence fix', async () => {
    root = makeFixtureWorkspace({ withMissingDescription: true });
    const inspection = await inspectSharkcraft({ cwd: root });
    const report = buildTemplateAudit(inspection);
    const plan = buildFixPlan(report);
    const fix = plan.fixes.find((f) => f.findingCategory === 'missing-description');
    expect(fix).toBeDefined();
    expect(fix!.confidence).toBe('high');
    expect(fix!.intent).toContain('description');
  });

  test('LLM findings are included as low-confidence advisory fixes tagged source=llm', async () => {
    root = makeFixtureWorkspace({ withWarning: true });
    const inspection = await inspectSharkcraft({ cwd: root });
    const baseReport = buildTemplateAudit(inspection);

    const mockProvider: IAiProvider = {
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
              {
                severity: 'info',
                category: 'stale-phrasing',
                message: 'Description references a deprecated API.',
                confidence: 0.6,
              },
            ],
          }),
          model: 'mock-model',
        });
      },
    };

    const enriched = await enrichAuditWithLlm(baseReport, {
      provider: mockProvider,
      inspection,
    });
    const plan = buildFixPlan(enriched);
    const llmFix = plan.fixes.find((f) => f.source === 'llm');
    expect(llmFix).toBeDefined();
    expect(llmFix!.confidence).toBe('low');
    expect(llmFix!.findingCategory).toBe('stale-phrasing');
  });

  test('summary counts match grouped fixes', () => {
    const report: ITemplateAuditReport = {
      auditId: 'audit-x',
      generatedAt: 'now',
      llmEnriched: false,
      llmProviderId: null,
      skipped: [],
      summary: { ok: 0, minor: 0, stale: 1, broken: 0, total: 1 },
      templates: [
        {
          templateId: 't',
          templateName: 't',
          verdict: 'stale',
          usage: 'unknown',
          deterministicFindings: [
            {
              severity: 'warn',
              category: 'undeclared-var',
              message: 'Placeholder {{x}} is not declared in variables[]',
              sources: ['templates lint'],
            },
            {
              severity: 'error',
              category: 'unsafe-target',
              message: 'targetPath escapes project root: /etc/passwd',
              sources: ['templates lint'],
            },
            {
              severity: 'info',
              category: 'related-id-unresolved',
              message: 'related id "x.y.z" not found.',
              sources: ['templates drift'],
            },
          ],
          llmFindings: [],
          suggestedActions: [],
        },
      ],
    };
    const plan = buildFixPlan(report);
    expect(plan.summary.fixCount).toBe(2);
    expect(plan.summary.skipped).toBe(1);
    expect(plan.summary.highConfidence + plan.summary.mediumConfidence + plan.summary.lowConfidence).toBe(2);
  });
});

describe('smart-context audit-templates command — --fix-plan integration', () => {
  let root: string;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('--fix-plan --json emits { report, fixPlan }', async () => {
    root = makeFixtureWorkspace({ withWarning: true });
    const { value, stdout } = await captureStdio(() =>
      smartContextAuditTemplatesCommand.run(
        makeArgs([], [
          ['cwd', root],
          ['json', true],
          ['no-enhance', true],
          ['fix-plan', true],
        ]),
      ),
    );
    expect(value).toBe(0);
    const parsed = JSON.parse(stdout) as { report: ITemplateAuditReport; fixPlan: ITemplateFixPlan };
    expect(parsed.report).toBeDefined();
    expect(parsed.fixPlan).toBeDefined();
    expect(parsed.fixPlan.auditId).toBe(parsed.report.auditId);
    expect(parsed.fixPlan.fixes.length).toBeGreaterThan(0);
  });

  test('--only-plan --json emits just the plan', async () => {
    root = makeFixtureWorkspace({ withWarning: true });
    const { value, stdout } = await captureStdio(() =>
      smartContextAuditTemplatesCommand.run(
        makeArgs([], [
          ['cwd', root],
          ['json', true],
          ['no-enhance', true],
          ['only-plan', true],
        ]),
      ),
    );
    expect(value).toBe(0);
    const parsed = JSON.parse(stdout) as ITemplateFixPlan;
    expect(parsed.fixPlanId).toBeDefined();
    expect(parsed.fixes).toBeDefined();
  });

  test('--fix-plan --save writes separate audit + plan files to disk', async () => {
    root = makeFixtureWorkspace({ withWarning: true });
    const { value } = await captureStdio(() =>
      smartContextAuditTemplatesCommand.run(
        makeArgs([], [
          ['cwd', root],
          ['save', true],
          ['no-enhance', true],
          ['fix-plan', true],
        ]),
      ),
    );
    expect(value).toBe(0);
    const dir = join(root, '.sharkcraft', 'smart-context');
    const files = readdirSync(dir);
    expect(files.some((f) => f.startsWith('audit-') && f.endsWith('.json'))).toBe(true);
    expect(files.some((f) => f.startsWith('fix-') && f.endsWith('.json'))).toBe(true);
    expect(files.some((f) => f.startsWith('fix-') && f.endsWith('.md'))).toBe(true);
    const planFile = files.find((f) => f.startsWith('fix-') && f.endsWith('.json'))!;
    const planBody = JSON.parse(readFileSync(join(dir, planFile), 'utf8')) as ITemplateFixPlan;
    expect(planBody.fixes.length).toBeGreaterThan(0);
  });

  test('without --fix-plan, behavior is unchanged (no plan emitted)', async () => {
    root = makeFixtureWorkspace({ withWarning: true });
    const { value, stdout } = await captureStdio(() =>
      smartContextAuditTemplatesCommand.run(
        makeArgs([], [
          ['cwd', root],
          ['json', true],
          ['no-enhance', true],
        ]),
      ),
    );
    expect(value).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed.fixPlan).toBeUndefined();
    expect(parsed.templates).toBeDefined();
  });
});
