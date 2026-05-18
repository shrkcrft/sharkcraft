import type { IPipelineDefinition, IPipelineStep } from '@shrkcrft/pipelines';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import { COMMAND_DICTIONARY } from './pipeline-command-dictionary.ts';

export interface IPipelineLintIssue {
  pipelineId: string;
  stepId?: string;
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

export interface IPipelineLintResult {
  pipelineId: string;
  issues: readonly IPipelineLintIssue[];
  passed: boolean;
}

export interface IPipelineLintReport {
  results: readonly IPipelineLintResult[];
  summary: { errors: number; warnings: number; info: number };
}

export function lintPipelines(
  inspection: ISharkcraftInspection,
  pipelineIds?: readonly string[],
): IPipelineLintReport {
  const all = inspection.pipelineRegistry.list();
  const targets =
    pipelineIds && pipelineIds.length > 0
      ? all.filter((p) => pipelineIds.includes(p.id))
      : all;
  const results: IPipelineLintResult[] = [];
  for (const p of targets) {
    const issues = lintOnePipeline(p, inspection);
    results.push({
      pipelineId: p.id,
      issues,
      passed: !issues.some((i) => i.severity === 'error'),
    });
  }
  const summary = { errors: 0, warnings: 0, info: 0 };
  for (const r of results) {
    for (const i of r.issues) {
      if (i.severity === 'error') summary.errors += 1;
      else if (i.severity === 'warning') summary.warnings += 1;
      else summary.info += 1;
    }
  }
  return { results, summary };
}

function lintOnePipeline(
  p: IPipelineDefinition,
  inspection: ISharkcraftInspection,
): IPipelineLintIssue[] {
  const issues: IPipelineLintIssue[] = [];
  const meta = p as unknown as { title?: string; description?: string };
  if (!meta.title && !meta.description) {
    issues.push({ pipelineId: p.id, code: 'missing-title', severity: 'warning', message: 'No title or description' });
  }
  let sawWritingStepWithoutReview = false;
  for (const step of p.steps) {
    if (!step.id) {
      issues.push({ pipelineId: p.id, code: 'missing-step-id', severity: 'error', message: 'Step has no id' });
    }
    if (!step.type) {
      issues.push({ pipelineId: p.id, stepId: step.id, code: 'missing-step-type', severity: 'error', message: 'Step has no type' });
    }
    // Template references — pipelines reference templates via `references`.
    for (const ref of step.references ?? []) {
      // Heuristic: only check ids that look like template ids (contain a hyphen
      // and no spaces). Pipelines may reference rules/paths too.
      if (/^[a-z][a-z0-9-]+$/.test(ref)) {
        const tpl = inspection.templateRegistry.get(ref);
        // If neither a template nor a rule with that id resolves, downgrade to info.
        if (!tpl && !inspection.ruleService.list().some((r) => r.id === ref)) {
          issues.push({
            pipelineId: p.id,
            stepId: step.id,
            code: 'unresolved-reference',
            severity: 'info',
            message: `Step references unresolved id "${ref}"`,
          });
        }
      }
    }
    for (const cmd of step.cliCommands ?? []) {
      const tok = firstToken(cmd);
      if (!COMMAND_DICTIONARY.includes(tok)) {
        issues.push({
          pipelineId: p.id,
          stepId: step.id,
          code: 'uncataloged-command',
          severity: 'info',
          message: `Command "${tok}" not in known catalog`,
        });
      }
    }
    if (isWriteStep(step) && !step.humanReview) {
      sawWritingStepWithoutReview = true;
      issues.push({
        pipelineId: p.id,
        stepId: step.id,
        code: 'write-without-review',
        severity: 'warning',
        message: 'Writing step has no humanReview marker',
      });
    }
  }
  if (sawWritingStepWithoutReview) {
    issues.push({
      pipelineId: p.id,
      code: 'review-points-missing',
      severity: 'warning',
      message: 'Pipeline has writing steps but no human review checkpoints',
    });
  }
  return issues;
}

function isWriteStep(step: IPipelineStep): boolean {
  if (step.type === 'apply-plan' || step.type === 'generation-plan') return true;
  for (const cmd of step.cliCommands ?? []) {
    if (cmd.startsWith('shrk apply')) return true;
    if (cmd.startsWith('shrk gen') && !cmd.includes('--dry-run')) return true;
  }
  return false;
}

function firstToken(cmd: string): string {
  return cmd.trim().split(/\s+/)[0] ?? '';
}

export interface IPipelineTestResult {
  pipelineId: string;
  passed: boolean;
  stepCount: number;
  warnings: readonly string[];
}

export function testPipelines(
  inspection: ISharkcraftInspection,
  pipelineIds?: readonly string[],
): readonly IPipelineTestResult[] {
  const all = inspection.pipelineRegistry.list();
  const targets =
    pipelineIds && pipelineIds.length > 0
      ? all.filter((p) => pipelineIds.includes(p.id))
      : all;
  const results: IPipelineTestResult[] = [];
  for (const p of targets) {
    const warnings: string[] = [];
    for (const step of p.steps) {
      for (const ref of step.references ?? []) {
        if (/^[a-z][a-z0-9-]+$/.test(ref)) {
          const tpl = inspection.templateRegistry.get(ref);
          if (!tpl && !inspection.ruleService.list().some((r) => r.id === ref)) {
            warnings.push(`step ${step.id} references unresolved id "${ref}"`);
          }
        }
      }
    }
    results.push({
      pipelineId: p.id,
      passed: warnings.length === 0,
      stepCount: p.steps.length,
      warnings,
    });
  }
  return results;
}
