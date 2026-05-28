import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { smartContextAuditTemplatesCommand } from '../commands/smart-context.command.ts';
import {
  buildTemplateAudit,
  type ITemplateAuditReport,
} from '../audit/templates-audit.ts';
import { enrichAuditWithLlm } from '../audit/templates-audit-llm.ts';
import { AiMessageRole, type IAiProvider } from '@shrkcrft/ai';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import type { ParsedArgs } from '../command-registry.ts';
import { ok } from '@shrkcrft/core';

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

interface IFixtureScenario {
  ok: 0 | 1;
  withWarning: 0 | 1;
  withError: 0 | 1;
}

function makeFixtureWorkspace(scenario: IFixtureScenario): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-audit-test-'));
  const sharkcraftDir = join(root, 'sharkcraft');
  mkdirSync(sharkcraftDir, { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'audit-fixture', version: '0.0.0', type: 'module' }, null, 2),
  );

  const okTemplate = `{
  id: 'ok.example',
  name: 'OK example',
  description: 'A clean template with no defects.',
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
  targetPath: ({ name }) => \`packages/example/\${name}.ts\`,
  content: ({ name, description }) => \`export const \${name} = { description: '\${description}' };\`,
}`;

  const warnTemplate = `{
  id: 'warn.example',
  name: 'Warn example',
  description: 'Has an undeclared placeholder (warning).',
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
  targetPath: 'packages/example/file.ts',
  content: 'export const x = {{undeclared}};',
}`;

  const errorTemplate = `{
  id: 'broken.example',
  name: 'Broken example',
  description: 'Has an unsafe targetPath (error).',
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
  targetPath: '/etc/passwd',
  content: () => 'irrelevant',
}`;

  const parts: string[] = [];
  if (scenario.ok) parts.push(okTemplate);
  if (scenario.withWarning) parts.push(warnTemplate);
  if (scenario.withError) parts.push(errorTemplate);
  writeFileSync(join(sharkcraftDir, 'templates.ts'), `export default [\n${parts.join(',\n')}\n];\n`);
  writeFileSync(
    join(sharkcraftDir, 'sharkcraft.config.ts'),
    `export default {
  projectName: 'audit-fixture',
  templateFiles: ['templates.ts'],
};\n`,
  );
  return root;
}

describe('buildTemplateAudit (deterministic orchestrator)', () => {
  let root: string;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('clean template yields ok verdict and no findings beyond info', async () => {
    root = makeFixtureWorkspace({ ok: 1, withWarning: 0, withError: 0 });
    const inspection = await inspectSharkcraft({ cwd: root });
    const report = buildTemplateAudit(inspection);
    expect(report.templates).toHaveLength(1);
    const entry = report.templates[0]!;
    expect(['ok', 'minor']).toContain(entry.verdict);
    expect(entry.deterministicFindings.every((f) => f.severity !== 'error')).toBe(true);
    expect(entry.llmFindings).toEqual([]);
    expect(report.llmEnriched).toBe(false);
  });

  test('undeclared placeholder produces stale verdict + suggested edit action', async () => {
    root = makeFixtureWorkspace({ ok: 0, withWarning: 1, withError: 0 });
    const inspection = await inspectSharkcraft({ cwd: root });
    const report = buildTemplateAudit(inspection);
    const entry = report.templates.find((t) => t.templateId === 'warn.example')!;
    expect(entry.verdict).toBe('stale');
    expect(
      entry.deterministicFindings.some((f) => f.category === 'undeclared-var'),
    ).toBe(true);
    expect(entry.suggestedActions.some((a) => a.kind === 'edit')).toBe(true);
  });

  test('unsafe targetPath produces broken verdict', async () => {
    root = makeFixtureWorkspace({ ok: 0, withWarning: 0, withError: 1 });
    const inspection = await inspectSharkcraft({ cwd: root });
    const report = buildTemplateAudit(inspection);
    const entry = report.templates.find((t) => t.templateId === 'broken.example')!;
    expect(entry.verdict).toBe('broken');
    expect(entry.deterministicFindings.some((f) => f.severity === 'error')).toBe(true);
    expect(report.summary.broken).toBe(1);
  });

  test('--id filter narrows the audit to one template', async () => {
    root = makeFixtureWorkspace({ ok: 1, withWarning: 1, withError: 0 });
    const inspection = await inspectSharkcraft({ cwd: root });
    const report = buildTemplateAudit(inspection, { templateId: 'warn.example' });
    expect(report.templates).toHaveLength(1);
    expect(report.templates[0]!.templateId).toBe('warn.example');
  });
});

describe('enrichAuditWithLlm (mocked provider)', () => {
  let root: string;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('merges parsed LLM findings into the report', async () => {
    root = makeFixtureWorkspace({ ok: 0, withWarning: 1, withError: 0 });
    const inspection = await inspectSharkcraft({ cwd: root });
    const baseReport = buildTemplateAudit(inspection);

    const mockProvider: IAiProvider = {
      id: 'mock-ollama',
      name: 'Mock Ollama',
      configure() {},
      isReady() {
        return true;
      },
      async send(_request) {
        return ok({
          content: JSON.stringify({
            findings: [
              {
                severity: 'warn',
                category: 'stale-phrasing',
                message: 'Description references an outdated framework version.',
                confidence: 0.7,
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
    expect(enriched.llmEnriched).toBe(true);
    expect(enriched.llmProviderId).toBe('mock-ollama');
    expect(enriched.templates[0]!.llmFindings).toHaveLength(1);
    expect(enriched.templates[0]!.llmFindings[0]!.category).toBe('stale-phrasing');
  });

  test('preserves deterministic findings when LLM call fails', async () => {
    root = makeFixtureWorkspace({ ok: 0, withWarning: 1, withError: 0 });
    const inspection = await inspectSharkcraft({ cwd: root });
    const baseReport = buildTemplateAudit(inspection);

    const failingProvider: IAiProvider = {
      id: 'mock-failing',
      name: 'Mock Failing',
      configure() {},
      isReady() {
        return true;
      },
      async send() {
        throw new Error('connection refused');
      },
    };

    const errs: Array<{ id: string; msg: string }> = [];
    const enriched = await enrichAuditWithLlm(baseReport, {
      provider: failingProvider,
      inspection,
      onPerTemplateError: (id, e) => errs.push({ id, msg: e.message }),
    });
    expect(enriched.llmEnriched).toBe(true);
    expect(enriched.templates[0]!.llmFindings).toEqual([]);
    expect(enriched.templates[0]!.deterministicFindings.length).toBeGreaterThan(0);
    expect(errs.length).toBeGreaterThan(0);
  });
});

describe('smart-context audit-templates command', () => {
  let root: string;
  beforeEach(() => {
    delete process.env.OLLAMA_HOST;
    delete process.env.AI_PROVIDER;
  });
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('--no-enhance + --json produces a well-formed deterministic report', async () => {
    root = makeFixtureWorkspace({ ok: 1, withWarning: 1, withError: 0 });
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
    const report = JSON.parse(stdout) as ITemplateAuditReport;
    expect(report.llmEnriched).toBe(false);
    expect(report.templates).toHaveLength(2);
    expect(report.summary.total).toBe(2);
  });

  test('--save writes timestamped md + json under .sharkcraft/smart-context/', async () => {
    root = makeFixtureWorkspace({ ok: 1, withWarning: 0, withError: 0 });
    const { value } = await captureStdio(() =>
      smartContextAuditTemplatesCommand.run(
        makeArgs([], [
          ['cwd', root],
          ['save', true],
          ['no-enhance', true],
        ]),
      ),
    );
    expect(value).toBe(0);
    const dir = join(root, '.sharkcraft', 'smart-context');
    expect(existsSync(dir)).toBe(true);
    const files = (await import('node:fs')).readdirSync(dir);
    const md = files.find((f) => f.startsWith('audit-') && f.endsWith('.md'));
    const json = files.find((f) => f.startsWith('audit-') && f.endsWith('.json'));
    expect(md).toBeTruthy();
    expect(json).toBeTruthy();
    const body = readFileSync(join(dir, json!), 'utf8');
    const parsed = JSON.parse(body) as ITemplateAuditReport;
    expect(parsed.summary.total).toBe(1);
  });

  test('exits 1 when any template is broken', async () => {
    root = makeFixtureWorkspace({ ok: 0, withWarning: 0, withError: 1 });
    const { value } = await captureStdio(() =>
      smartContextAuditTemplatesCommand.run(
        makeArgs([], [
          ['cwd', root],
          ['json', true],
          ['no-enhance', true],
        ]),
      ),
    );
    expect(value).toBe(1);
  });

  test('LLM message construction includes deterministic findings and sibling summaries', async () => {
    root = makeFixtureWorkspace({ ok: 1, withWarning: 1, withError: 0 });
    const inspection = await inspectSharkcraft({ cwd: root });
    const base = buildTemplateAudit(inspection);
    const llm = await import('../audit/templates-audit-llm.ts');
    const messages = llm.__internals.buildEnrichmentMessages(
      inspection.templateRegistry.get('warn.example')!,
      inspection.templateRegistry.list().filter((t) => t.id !== 'warn.example'),
      base.templates.find((t) => t.templateId === 'warn.example')!,
    );
    expect(messages[0]!.role).toBe(AiMessageRole.System);
    expect(messages[1]!.content).toContain('warn.example');
    expect(messages[1]!.content).toContain('Deterministic findings');
    expect(messages[1]!.content).toContain('Sibling templates');
  });
});
