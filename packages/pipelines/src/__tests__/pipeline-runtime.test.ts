import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  definePipeline,
  findNextStep,
  interpolatePipeline,
  loadPipelinesFromFile,
  PipelineStepType,
  renderPipelineScript,
} from '../index.ts';

// --- fixtures ----------------------------------------------------------------

const fixture = definePipeline({
  id: 'demo',
  title: 'Demo',
  description: 'A demo pipeline',
  inputs: [{ name: 'service', required: true }],
  steps: [
    {
      id: 'ctx',
      type: PipelineStepType.Context,
      description: 'context for <task>',
      cliCommands: ['shrk context --task "<task>" --repo <repo> --pipeline <pipelineId>'],
      references: ['knowledge:foo'],
    },
    {
      id: 'gen',
      type: PipelineStepType.Command,
      cliCommands: ['shrk gen <service>'],
    },
    {
      id: 'unknown',
      type: PipelineStepType.Command,
      cliCommands: ['echo <doesNotExist>'],
    },
    {
      id: 'opt',
      type: PipelineStepType.Command,
      required: false,
      cliCommands: ['echo optional'],
    },
    {
      id: 'gated',
      type: PipelineStepType.Command,
      enabledWhen: 'withTests',
      cliCommands: ['echo gated'],
    },
  ],
});

// --- interpolatePipeline -----------------------------------------------------

describe('interpolatePipeline', () => {
  const out = interpolatePipeline(fixture, {
    task: 'add login',
    projectRoot: '/repo',
    inputs: { service: 'auth' },
  });
  const byId = (id: string) => out.steps.find((s) => s.id === id)!;

  test('substitutes <task>, <repo>, <pipelineId> and named <input> placeholders', () => {
    expect(byId('ctx').cliCommands[0]).toBe(
      'shrk context --task "add login" --repo /repo --pipeline demo',
    );
    expect(byId('ctx').description).toBe('context for add login');
    expect(byId('gen').cliCommands[0]).toBe('shrk gen auth');
  });

  test('leaves unknown placeholders intact', () => {
    expect(byId('unknown').cliCommands[0]).toBe('echo <doesNotExist>');
  });

  test('exposes every resolved value via inputs (for traceability)', () => {
    expect(out.inputs).toMatchObject({
      task: 'add login',
      repo: '/repo',
      pipelineId: 'demo',
      service: 'auth',
    });
  });

  test('defaults <repo> to the literal placeholder when projectRoot is omitted', () => {
    const noRepo = interpolatePipeline(fixture, { task: 't' });
    expect(noRepo.steps.find((s) => s.id === 'ctx')!.cliCommands[0]).toContain('--repo <repo>');
    expect(noRepo.inputs.repo).toBe('<repo>');
  });

  test('marks optional + enabledWhen steps skipped by default; required stay', () => {
    expect(byId('ctx').skipped).toBe(false);
    expect(byId('gen').skipped).toBe(false);
    expect(byId('opt').skipped).toBe(true);
    expect(byId('gated').skipped).toBe(true);
  });

  test('includeOptional by step id un-skips only that optional step', () => {
    const o = interpolatePipeline(fixture, { task: 't', includeOptional: ['opt'] });
    expect(o.steps.find((s) => s.id === 'opt')!.skipped).toBe(false);
    expect(o.steps.find((s) => s.id === 'gated')!.skipped).toBe(true);
  });

  test('includeOptional matches an enabledWhen key, or the gated step id', () => {
    const byWhen = interpolatePipeline(fixture, { task: 't', includeOptional: ['withTests'] });
    expect(byWhen.steps.find((s) => s.id === 'gated')!.skipped).toBe(false);
    expect(byWhen.steps.find((s) => s.id === 'opt')!.skipped).toBe(true);

    const byStepId = interpolatePipeline(fixture, { task: 't', includeOptional: ['gated'] });
    expect(byStepId.steps.find((s) => s.id === 'gated')!.skipped).toBe(false);
  });

  test("includeOptional '*' un-skips every optional/gated step", () => {
    const all = interpolatePipeline(fixture, { task: 't', includeOptional: ['*'] });
    expect(all.steps.every((s) => !s.skipped)).toBe(true);
  });
});

// --- findNextStep ------------------------------------------------------------

describe('findNextStep', () => {
  test('returns the first non-skipped step', () => {
    const out = interpolatePipeline(fixture, { task: 't' });
    expect(findNextStep(out)?.id).toBe('ctx');
  });

  test('returns null when every step is skipped', () => {
    const allOptional = definePipeline({
      id: 'allopt',
      title: 'All optional',
      description: 'd',
      steps: [
        { id: 'a', type: PipelineStepType.Command, required: false, cliCommands: ['echo a'] },
        { id: 'b', type: PipelineStepType.Command, required: false, cliCommands: ['echo b'] },
      ],
    });
    const out = interpolatePipeline(allOptional, { task: 't' });
    expect(out.steps.every((s) => s.skipped)).toBe(true);
    expect(findNextStep(out)).toBeNull();

    const included = interpolatePipeline(allOptional, { task: 't', includeOptional: ['*'] });
    expect(findNextStep(included)?.id).toBe('a');
  });
});

// --- renderPipelineScript ----------------------------------------------------

describe('renderPipelineScript', () => {
  test('renders a small pipeline to a deterministic script (snapshot)', () => {
    const small = definePipeline({
      id: 'small',
      title: 'Small',
      description: 'desc',
      steps: [
        {
          id: 'build',
          type: PipelineStepType.Command,
          cliCommands: ['shrk context --task "<task>"'],
        },
        { id: 'test', type: PipelineStepType.Command, cliCommands: ['bun test'] },
      ],
    });
    const script = renderPipelineScript(interpolatePipeline(small, { task: 'do x' }));
    const expected = [
      '#!/usr/bin/env bash',
      '# Generated by `shrk pipelines script`.',
      '# Pipeline: small — Small',
      '# Task: do x',
      'set -euo pipefail',
      '',
      '# === 1. [command] build ===',
      'shrk context --task "do x"',
      '',
      '# === 2. [command] test ===',
      'bun test',
      '',
    ].join('\n');
    expect(script).toBe(expected);
  });

  test('emits agent no-op echo, write-confirm stanza, HUMAN REVIEW + skipped markers', () => {
    const branchy = definePipeline({
      id: 'branchy',
      title: 'Branchy',
      description: 'd',
      steps: [
        { id: 'think', type: PipelineStepType.Agent, instruction: 'reason about <task>' },
        {
          id: 'apply',
          type: PipelineStepType.ApplyPlan,
          humanReview: true,
          cliCommands: ['shrk apply plan.json'],
        },
        { id: 'opt', type: PipelineStepType.Command, required: false, cliCommands: ['echo optional'] },
      ],
    });
    const script = renderPipelineScript(interpolatePipeline(branchy, { task: 'ship it' }));

    // agent step: instruction interpolated + no-op echo
    expect(script).toContain('# === 1. [agent] think ===');
    expect(script).toContain('# instruction: reason about ship it');
    expect(script).toContain('echo "→ think: agent/mcp action — no shell command"');
    // write step: HUMAN REVIEW tag + confirm stanza + verbatim command
    expect(script).toContain('[HUMAN REVIEW]');
    expect(script).toContain(
      'echo "About to write files. Confirm by pressing Enter, or Ctrl-C to abort."',
    );
    expect(script).toContain('read -r _');
    expect(script).toContain('shrk apply plan.json');
    // skipped optional step renders its own marker, no command body
    expect(script).toContain('# === 3. opt (skipped — optional, not included) ===');
    expect(script).not.toContain('echo optional');
  });
});

// --- loadPipelinesFromFile ---------------------------------------------------

const createdDirs: string[] = [];
function writeModule(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'shrk-pipeline-load-'));
  createdDirs.push(dir);
  const file = join(dir, name);
  writeFileSync(file, body);
  return file;
}

afterAll(() => {
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
});

describe('loadPipelinesFromFile', () => {
  test('a missing file yields a not-found warning and no pipelines', async () => {
    const missing = join(tmpdir(), `shrk-pipeline-missing-${Date.now()}`, 'pipelines.ts');
    const res = await loadPipelinesFromFile(missing);
    expect(res.pipelines).toEqual([]);
    expect(res.warnings.some((w) => w.includes('not found'))).toBe(true);
  });

  test('loads a default-exported pipeline object and stamps its source origin', async () => {
    const file = writeModule(
      'default.ts',
      `export default {
        id: 'loaded',
        title: 'Loaded',
        description: 'd',
        steps: [{ id: 's1', type: 'command', cliCommands: ['echo hi'] }],
      };\n`,
    );
    const res = await loadPipelinesFromFile(file);
    expect(res.pipelines.map((p) => p.id)).toEqual(['loaded']);
    expect(res.pipelines[0]?.source?.origin).toBe(file);
    expect(res.warnings).toEqual([]);
  });

  test('loads pipelines exported as an array', async () => {
    const file = writeModule(
      'array.ts',
      `export const pipelines = [
        { id: 'p1', title: 'P1', description: 'd', steps: [{ id: 'a', type: 'command' }] },
        { id: 'p2', title: 'P2', description: 'd', steps: [{ id: 'b', type: 'command' }] },
      ];\n`,
    );
    const res = await loadPipelinesFromFile(file);
    expect(res.pipelines.map((p) => p.id)).toEqual(['p1', 'p2']);
  });

  test('warns when a present file exports no pipelines', async () => {
    const file = writeModule('empty.ts', `export const nothing = 42;\n`);
    const res = await loadPipelinesFromFile(file);
    expect(res.pipelines).toEqual([]);
    expect(res.warnings.some((w) => w.includes('No pipelines exported'))).toBe(true);
  });
});
