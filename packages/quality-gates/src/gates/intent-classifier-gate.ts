import {
  loadIntentBenchmark,
  runIntentBenchmark,
} from '@shrkcrft/context-planner';
import type { IGateResult } from '../schema/quality-gate.ts';

export interface IIntentClassifierGateOptions {
  /** Accuracy below this threshold fails the gate. Default 0.6. */
  failBelow?: number;
  /** Accuracy below this threshold warns. Default 0.95. */
  warnBelow?: number;
}

/**
 * Run the intent-classifier benchmark in-process and gate on the
 * accuracy. Skipped when no fixture is present at
 * `sharkcraft/intent-benchmark.json` (the feature is opt-in). The gate
 * does NOT persist a fresh run report — that's the CLI's job.
 */
export function intentClassifierGate(
  projectRoot: string,
  options: IIntentClassifierGateOptions = {},
): IGateResult {
  const start = Date.now();
  const failBelow = options.failBelow ?? 0.6;
  const warnBelow = options.warnBelow ?? 0.95;
  const benchmark = loadIntentBenchmark(projectRoot);
  if (!benchmark) {
    return {
      id: 'intent-classifier',
      label: 'Intent classifier accuracy',
      status: 'skipped',
      message: 'No fixture at sharkcraft/intent-benchmark.json.',
      durationMs: Date.now() - start,
    };
  }
  if (benchmark.cases.length === 0) {
    return {
      id: 'intent-classifier',
      label: 'Intent classifier accuracy',
      status: 'skipped',
      message: 'Benchmark has zero cases.',
      durationMs: Date.now() - start,
    };
  }
  const run = runIntentBenchmark(benchmark);
  const pct = Math.round(run.accuracy * 1000) / 10;
  if (run.accuracy >= warnBelow) {
    return {
      id: 'intent-classifier',
      label: 'Intent classifier accuracy',
      status: 'pass',
      message: `Accuracy ${pct}% (${run.passed}/${run.total}).`,
      details: { accuracy: run.accuracy, passed: run.passed, failed: run.failed, total: run.total },
      durationMs: Date.now() - start,
    };
  }
  const status = run.accuracy < failBelow ? 'fail' : 'warn';
  const sample = run.cases
    .filter((c) => !c.passed)
    .slice(0, 3)
    .map((c) => `expected=${c.expected}, actual=${c.actual}`)
    .join('; ');
  return {
    id: 'intent-classifier',
    label: 'Intent classifier accuracy',
    status,
    message:
      `Accuracy ${pct}% (${run.passed}/${run.total}). ${run.failed} miss(es): ${sample}.`,
    details: {
      accuracy: run.accuracy,
      passed: run.passed,
      failed: run.failed,
      total: run.total,
      threshold: { failBelow, warnBelow },
    },
    nextCommands: ['shrk context benchmark'],
    durationMs: Date.now() - start,
  };
}
