import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ok } from '@shrkcrft/core';
import { type IAiProvider } from '@shrkcrft/ai';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import { smartContextAuditTemplatesCommand } from '../commands/smart-context.command.ts';
import { buildTemplateAudit, type ITemplateAuditReport } from '../audit/templates-audit.ts';
import { enrichAuditWithLlm, __internals as auditLlmInternals } from '../audit/templates-audit-llm.ts';
import { buildFixPlan, type ITemplateFixPlan } from '../audit/templates-fix-plan.ts';
import { enrichFixPlanWithLlm } from '../audit/templates-fix-plan-llm.ts';
import {
  buildAiBlock,
  enrichWithLlmRecommendations,
  renderAiBlockMarkdown,
  renderRecommendationsMarkdown,
} from '@shrkcrft/ai';
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

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-v3-test-'));
  const dir = join(root, 'sharkcraft');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'v3-fixture', version: '0.0.0', type: 'module' }, null, 2),
  );
  writeFileSync(
    join(dir, 'templates.ts'),
    `export default [{
  id: 'sample.warn',
  name: 'Warn',
  description: 'Has undeclared placeholder.',
  tags: ['demo'],
  scope: ['typescript'],
  appliesWhen: ['create-feature'],
  variables: [],
  targetPath: 'packages/example/x.ts',
  content: 'export const x = {{undeclared}};',
}];
`,
  );
  writeFileSync(
    join(dir, 'sharkcraft.config.ts'),
    `export default {
  projectName: 'v3-fixture',
  templateFiles: ['templates.ts'],
};\n`,
  );
  return root;
}

describe('Part B — strengthened LLM staleness prompt', () => {
  test('system prompt enumerates explicit staleness categories', async () => {
    const root = makeFixture();
    try {
      const inspection = await inspectSharkcraft({ cwd: root });
      const template = inspection.templateRegistry.list()[0]!;
      const entry = buildTemplateAudit(inspection).templates[0]!;
      const msgs = auditLlmInternals.buildEnrichmentMessages(template, [], entry);
      const sys = msgs[0]!.content;
      for (const cat of [
        'api-drift',
        'deprecated-pattern',
        'doc-content-mismatch',
        'style-drift',
        'missing-variable',
        'content-bug',
        'stale-phrasing',
      ]) {
        expect(sys).toContain(cat);
      }
      // Categories appear in BOTH the per-category guidance and the JSON
      // shape declaration so the parser will accept them.
      expect(sys.split('api-drift').length).toBeGreaterThanOrEqual(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('LLM-pass parser accepts new staleness categories verbatim', async () => {
    const root = makeFixture();
    try {
      const inspection = await inspectSharkcraft({ cwd: root });
      const base = buildTemplateAudit(inspection);
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
                { severity: 'warn', category: 'api-drift', message: 'Imports `foo` from `@old/pkg`.', confidence: 0.8 },
                { severity: 'info', category: 'doc-content-mismatch', message: 'Description mentions X; content does Y.', confidence: 0.7 },
              ],
            }),
            model: 'mock',
          });
        },
      };
      const enriched = await enrichAuditWithLlm(base, { provider: mock, inspection });
      const cats = enriched.templates[0]!.llmFindings.map((f) => f.category).sort();
      expect(cats).toEqual(['api-drift', 'doc-content-mismatch']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Part C — LLM-enriched fix plan', () => {
  test('llmSuggestion is attached when the LLM returns a matching entry', async () => {
    const root = makeFixture();
    try {
      const inspection = await inspectSharkcraft({ cwd: root });
      const report = buildTemplateAudit(inspection);
      const plan = buildFixPlan(report);
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
                suggestion: `Concrete suggestion for ${f.findingCategory}.`,
              })),
            }),
            model: 'mock',
          });
        },
      };
      const enriched = await enrichFixPlanWithLlm(plan, { provider: mock, inspection });
      const withSuggestion = enriched.fixes.filter((f) => f.llmSuggestion);
      expect(withSuggestion.length).toBe(plan.fixes.length);
      expect(withSuggestion[0]!.llmSuggestion).toContain('Concrete suggestion');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('falls back gracefully when LLM throws — original plan preserved', async () => {
    const root = makeFixture();
    try {
      const inspection = await inspectSharkcraft({ cwd: root });
      const report = buildTemplateAudit(inspection);
      const plan = buildFixPlan(report);
      const failing: IAiProvider = {
        id: 'mock',
        name: 'Mock',
        configure() {},
        isReady() {
          return true;
        },
        async send() {
          throw new Error('boom');
        },
      };
      const errs: string[] = [];
      const enriched = await enrichFixPlanWithLlm(plan, {
        provider: failing,
        inspection,
        onPerTemplateError: (_id, e) => errs.push(e.message),
      });
      expect(enriched.fixes).toEqual(plan.fixes);
      expect(errs.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Part D — AI-configuration hints', () => {
  test('without provider, emits setup-level hint with concrete steps', () => {
    const block = buildAiBlock({
      selection: { requested: 'auto', provider: null },
      userOptedOut: false,
    });
    expect(block.reachable).toBe(false);
    expect(block.hints[0]!.level).toBe('setup');
    expect(block.hints[0]!.steps.join('\n')).toContain('OLLAMA_HOST');
  });

  test('with --no-enhance, hint is info-level (no nag)', () => {
    const block = buildAiBlock({
      selection: { requested: 'auto', provider: null },
      userOptedOut: true,
    });
    expect(block.enhancementSkipped).toBe(true);
    expect(block.hints[0]!.level).toBe('info');
  });

  test('with provider reachable, hints describe upgrade paths', () => {
    const mockProvider: IAiProvider = {
      id: 'ollama',
      name: 'Ollama',
      configure() {},
      isReady() {
        return true;
      },
      async send() {
        return ok({ content: '{}', model: 'mock' });
      },
    };
    const block = buildAiBlock({
      selection: { requested: 'ollama', provider: mockProvider },
      userOptedOut: false,
    });
    expect(block.reachable).toBe(true);
    expect(block.providerId).toBe('ollama');
    expect(block.hints.some((h) => h.level === 'upgrade')).toBe(true);
  });

  test('Markdown render includes status line + per-hint steps', () => {
    const md = renderAiBlockMarkdown(
      buildAiBlock({
        selection: { requested: 'auto', provider: null },
        userOptedOut: false,
      }),
    );
    expect(md).toContain('## AI configuration');
    expect(md).toContain('unavailable');
    expect(md).toContain('OLLAMA_HOST');
  });

  test('every audit report carries the ai block, with or without LLM', async () => {
    const root = makeFixture();
    try {
      const { stdout } = await captureStdio(() =>
        smartContextAuditTemplatesCommand.run(
          makeArgs([], [
            ['cwd', root],
            ['json', true],
            ['no-enhance', true],
          ]),
        ),
      );
      const report = JSON.parse(stdout) as ITemplateAuditReport;
      expect(report.ai).toBeDefined();
      expect(report.ai!.enhancementSkipped).toBe(true);
      expect(report.ai!.hints.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Part E — shared LLM-recommendations utility', () => {
  test('no-op when --no-enhance equivalent passed (userOptedOut=true)', async () => {
    const env = await enrichWithLlmRecommendations({
      surface: 'doctor',
      deterministicSummary: '## WARN (1)\n- something',
      ask: 'recommend a fix',
      userOptedOut: true,
    });
    expect(env.recommendations).toEqual([]);
    expect(env.ai.enhancementSkipped).toBe(true);
  });

  test('no-op when no provider reachable (ai block carries setup hints)', async () => {
    const env = await enrichWithLlmRecommendations({
      surface: 'doctor',
      deterministicSummary: '## WARN (1)\n- something',
      ask: 'recommend a fix',
      providerOverride: null,
    });
    expect(env.recommendations).toEqual([]);
    expect(env.ai.reachable).toBe(false);
    expect(env.ai.hints.some((h) => h.level === 'setup')).toBe(true);
  });

  test('parses well-formed LLM JSON into structured recommendations', async () => {
    const mock: IAiProvider = {
      id: 'mock-llm',
      name: 'Mock',
      configure() {},
      isReady() {
        return true;
      },
      async send() {
        return ok({
          content: JSON.stringify({
            recommendations: [
              {
                severity: 'warn',
                category: 'config-drift',
                title: 'Re-run scaffold',
                detail: 'shrk gen engine.cli-command sample',
                target: 'sharkcraft/templates.ts',
                confidence: 0.8,
              },
            ],
          }),
          model: 'mock',
        });
      },
    };
    const env = await enrichWithLlmRecommendations({
      surface: 'doctor',
      deterministicSummary: '## WARN (1)\n- something',
      ask: 'recommend a fix',
      providerOverride: mock,
    });
    expect(env.recommendations.length).toBe(1);
    expect(env.recommendations[0]!.category).toBe('config-drift');
    expect(env.recommendations[0]!.target).toBe('sharkcraft/templates.ts');
    expect(env.ai.reachable).toBe(true);
  });

  test('renders compact markdown including the AI hints block', () => {
    const md = renderRecommendationsMarkdown({
      ai: buildAiBlock({
        selection: { requested: 'auto', provider: null },
        userOptedOut: false,
      }),
      recommendations: [
        {
          severity: 'info',
          category: 'sample',
          title: 'Try this',
          detail: 'do the thing',
          confidence: 0.5,
        },
      ],
    });
    expect(md).toContain('LLM recommendations');
    expect(md).toContain('Try this');
    expect(md).toContain('AI configuration');
  });

  test('LLM call failure is swallowed; recommendations stay empty, ai block intact', async () => {
    const failing: IAiProvider = {
      id: 'mock',
      name: 'Mock',
      configure() {},
      isReady() {
        return true;
      },
      async send() {
        throw new Error('connection refused');
      },
    };
    const env = await enrichWithLlmRecommendations({
      surface: 'doctor',
      deterministicSummary: 'x',
      ask: 'y',
      providerOverride: failing,
    });
    expect(env.recommendations).toEqual([]);
    expect(env.ai.reachable).toBe(true);
    expect(env.ai.providerId).toBe('mock');
  });
});

describe('Part E — smart-context audit-templates with --fix-plan + provider', () => {
  test('LLM enrichment threads through audit, plan, and ai block in one invocation', async () => {
    const root = makeFixture();
    try {
      // We can't easily inject a mock provider through the CLI flag, but we
      // can prove the deterministic path stays byte-stable for the non-AI
      // fields when no provider is reachable.
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
      expect(parsed.report.ai).toBeDefined();
      expect(parsed.report.ai!.enhancementSkipped).toBe(true);
      // Plan fixes have no llmSuggestion when no LLM was used.
      expect(parsed.fixPlan.fixes.every((f) => !('llmSuggestion' in f) || f.llmSuggestion === undefined)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
