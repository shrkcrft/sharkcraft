/**
 * `shrk apply --batch <plan.json>` runner.
 *
 * Executes a multi-step fix-chain. Each step is a single `shrk` invocation
 * with a stable kind keyword and forwarded args. The runner:
 *
 *   1. Parses the plan JSON, validates the schema and step kinds.
 *   2. Computes a content-hash `batchId` for provenance grouping.
 *   3. Runs each step in sequence with `--apply --json`.
 *   4. Stops on the first refusal unless `--allow-divergent` is set.
 *   5. Returns an aggregated structured report.
 *
 * Each underlying step is itself preview-first (it previews internally
 * then writes), so a non-atomic batch matches the documented contract: a
 * refusal in step N stops the batch but step N-1's writes are kept.
 * With `--allow-divergent`, refused steps are skipped and survivors
 * apply, identical to per-command semantics today.
 *
 * Supported step kinds:
 *   - `action-hints`
 *   - `knowledge-stale`
 *   - `template-drift`
 *
 * Each step's `args` is a free-form record forwarded to the underlying
 * CLI. The runner translates them to `--key value` / `--flag` form.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const APPLY_BATCH_SCHEMA = 'sharkcraft.apply-batch.v1';

export type BatchStepKind = 'action-hints' | 'knowledge-stale' | 'template-drift';

export interface IApplyBatchStep {
  readonly kind: BatchStepKind;
  readonly args?: Readonly<Record<string, string | number | boolean | readonly string[]>>;
}

export interface IApplyBatchPlan {
  readonly schema: typeof APPLY_BATCH_SCHEMA;
  readonly steps: readonly IApplyBatchStep[];
}

export interface IApplyBatchStepResult {
  readonly kind: BatchStepKind;
  readonly stepIndex: number;
  readonly exitCode: number;
  readonly outcome: 'applied' | 'refused' | 'no-op' | 'error';
  readonly stdoutJson?: unknown;
  readonly stderr?: string;
}

export interface IApplyBatchReport {
  readonly schema: 'sharkcraft.apply-batch-report/v1';
  readonly batchId: string;
  readonly allowDivergent: boolean;
  readonly steps: readonly IApplyBatchStepResult[];
  readonly stopped: boolean;
  readonly success: boolean;
}

export class ApplyBatchPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApplyBatchPlanError';
  }
}

const VALID_KINDS: ReadonlySet<BatchStepKind> = new Set([
  'action-hints',
  'knowledge-stale',
  'template-drift',
]);

export function parseApplyBatchPlan(raw: string): IApplyBatchPlan {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new ApplyBatchPlanError(`Plan is not valid JSON: ${(e as Error).message}`);
  }
  if (!json || typeof json !== 'object') {
    throw new ApplyBatchPlanError('Plan must be a JSON object.');
  }
  const o = json as Record<string, unknown>;
  if (o.schema !== APPLY_BATCH_SCHEMA) {
    throw new ApplyBatchPlanError(`Plan schema must be "${APPLY_BATCH_SCHEMA}".`);
  }
  if (!Array.isArray(o.steps)) {
    throw new ApplyBatchPlanError('Plan.steps must be an array.');
  }
  const steps: IApplyBatchStep[] = [];
  for (let i = 0; i < o.steps.length; i++) {
    const s = o.steps[i];
    if (!s || typeof s !== 'object') {
      throw new ApplyBatchPlanError(`step[${i}] must be an object.`);
    }
    const kind = (s as Record<string, unknown>).kind;
    if (typeof kind !== 'string' || !VALID_KINDS.has(kind as BatchStepKind)) {
      throw new ApplyBatchPlanError(
        `step[${i}].kind must be one of: ${[...VALID_KINDS].join(', ')}. Got ${JSON.stringify(kind)}.`,
      );
    }
    const argsRaw = (s as Record<string, unknown>).args;
    if (argsRaw !== undefined && (typeof argsRaw !== 'object' || argsRaw === null || Array.isArray(argsRaw))) {
      throw new ApplyBatchPlanError(`step[${i}].args must be a flat record if present.`);
    }
    const args: Record<string, string | number | boolean | readonly string[]> = {};
    if (argsRaw) {
      for (const [k, v] of Object.entries(argsRaw as Record<string, unknown>)) {
        if (
          typeof v === 'string' ||
          typeof v === 'number' ||
          typeof v === 'boolean' ||
          (Array.isArray(v) && v.every((x) => typeof x === 'string'))
        ) {
          args[k] = v as string | number | boolean | readonly string[];
        } else {
          throw new ApplyBatchPlanError(
            `step[${i}].args.${k} must be string|number|boolean|string[]. Got ${JSON.stringify(v)}.`,
          );
        }
      }
    }
    steps.push({ kind: kind as BatchStepKind, ...(Object.keys(args).length > 0 ? { args } : {}) });
  }
  return { schema: APPLY_BATCH_SCHEMA, steps };
}

export function computeBatchId(plan: IApplyBatchPlan): string {
  const h = createHash('sha256');
  h.update(JSON.stringify(plan));
  return 'batch_' + h.digest('hex').slice(0, 12);
}

function buildCliArgs(step: IApplyBatchStep): string[] {
  // All batch steps target `shrk fix --<kind> --apply --json`.
  const out: string[] = ['fix', `--${step.kind}`, '--apply', '--json'];
  if (step.args) {
    for (const [k, v] of Object.entries(step.args)) {
      if (typeof v === 'boolean') {
        if (v) out.push(`--${k}`);
      } else if (Array.isArray(v)) {
        for (const item of v) {
          out.push(`--${k}`);
          out.push(item);
        }
      } else {
        out.push(`--${k}`);
        out.push(String(v));
      }
    }
  }
  return out;
}

export interface IRunApplyBatchOptions {
  readonly plan: IApplyBatchPlan;
  readonly allowDivergent: boolean;
  readonly dryRun?: boolean;
  /** Working directory for the spawned shrk processes. */
  readonly cwd: string;
  /** Absolute path to the `shrk` executable. */
  readonly shrkBin: string;
}

export function runApplyBatch(options: IRunApplyBatchOptions): IApplyBatchReport {
  const { plan, allowDivergent, cwd, shrkBin, dryRun } = options;
  const batchId = computeBatchId(plan);
  const results: IApplyBatchStepResult[] = [];
  let stopped = false;
  let success = true;

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i]!;
    const cliArgs = buildCliArgs(step);
    if (dryRun) {
      results.push({
        kind: step.kind,
        stepIndex: i,
        exitCode: 0,
        outcome: 'no-op',
        stdoutJson: { dryRun: true, command: `${shrkBin} ${cliArgs.join(' ')}` },
      });
      continue;
    }
    const proc = spawnSync(shrkBin, cliArgs, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, SHARKCRAFT_BATCH_ID: batchId, SHARKCRAFT_BATCH_STEP: String(i) },
    });
    const exitCode = typeof proc.status === 'number' ? proc.status : 1;
    let parsed: unknown = undefined;
    try {
      parsed = JSON.parse(proc.stdout ?? '{}');
    } catch {
      // leave undefined
    }
    let outcome: IApplyBatchStepResult['outcome'] = 'applied';
    if (exitCode !== 0) {
      outcome = 'refused';
    } else if (parsed && typeof parsed === 'object') {
      const m = (parsed as Record<string, unknown>).mode;
      if (m === 'refused') outcome = 'refused';
      else if (m === 'applied') outcome = 'applied';
      else outcome = 'no-op';
    } else {
      outcome = 'no-op';
    }
    results.push({
      kind: step.kind,
      stepIndex: i,
      exitCode,
      outcome,
      ...(parsed !== undefined ? { stdoutJson: parsed } : {}),
      ...(proc.stderr ? { stderr: proc.stderr } : {}),
    });
    if (outcome === 'refused' && !allowDivergent) {
      stopped = true;
      success = false;
      break;
    }
    if (outcome === 'refused') {
      success = false;
    }
  }

  return {
    schema: 'sharkcraft.apply-batch-report/v1',
    batchId,
    allowDivergent,
    steps: results,
    stopped,
    success,
  };
}
