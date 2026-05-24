import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { classifyIntent } from './classify-intent.ts';
import type { TaskIntent } from '../schema/context-pack.ts';

export const INTENT_BENCHMARK_SCHEMA = 'sharkcraft.intent-benchmark/v1' as const;

/**
 * One labelled task → expected-intent pair. The benchmark runs every
 * case through `classifyIntent` and reports per-case + aggregate
 * accuracy. Optional `notes` lets authors leave a hint about why a
 * particular phrasing was added (often after a regression).
 */
export interface IIntentBenchmarkCase {
  task: string;
  expected: TaskIntent;
  notes?: string;
}

export interface IIntentBenchmark {
  schema: typeof INTENT_BENCHMARK_SCHEMA;
  cases: readonly IIntentBenchmarkCase[];
}

export interface IIntentBenchmarkRunCase {
  task: string;
  expected: TaskIntent;
  actual: TaskIntent;
  passed: boolean;
}

export interface IIntentBenchmarkRun {
  schema: typeof INTENT_BENCHMARK_SCHEMA;
  total: number;
  passed: number;
  failed: number;
  /** Accuracy in [0, 1]. */
  accuracy: number;
  cases: readonly IIntentBenchmarkRunCase[];
  /** ISO timestamp the run completed. */
  ranAt: string;
}

const BENCHMARK_REL = 'sharkcraft/intent-benchmark.json';

/**
 * Read the benchmark fixture from `sharkcraft/intent-benchmark.json`
 * (NOT under `.sharkcraft/` — this is an author-provided, checked-in
 * fixture, not derived state). Returns undefined when missing or when
 * the file is unparseable; the caller should treat that as "no
 * benchmark configured" rather than an error.
 */
export function loadIntentBenchmark(projectRoot: string): IIntentBenchmark | undefined {
  const abs = nodePath.join(projectRoot, BENCHMARK_REL);
  if (!existsSync(abs)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(abs, 'utf8')) as IIntentBenchmark;
    if (raw.schema !== INTENT_BENCHMARK_SCHEMA) return undefined;
    if (!Array.isArray(raw.cases)) return undefined;
    return raw;
  } catch {
    return undefined;
  }
}

/**
 * Run the benchmark in-process. Pure — no side effects, no I/O beyond
 * the input. Callers persist the run via `writeBenchmarkRun` when they
 * want the doctor to surface it.
 */
export function runIntentBenchmark(
  benchmark: IIntentBenchmark,
): IIntentBenchmarkRun {
  const cases: IIntentBenchmarkRunCase[] = [];
  let passed = 0;
  for (const c of benchmark.cases) {
    const actual = classifyIntent(c.task);
    const ok = actual === c.expected;
    if (ok) passed += 1;
    cases.push({ task: c.task, expected: c.expected, actual, passed: ok });
  }
  const total = benchmark.cases.length;
  return {
    schema: INTENT_BENCHMARK_SCHEMA,
    total,
    passed,
    failed: total - passed,
    accuracy: total === 0 ? 1 : passed / total,
    cases,
    ranAt: new Date().toISOString(),
  };
}

export const INTENT_BENCHMARK_RUN_REL =
  '.sharkcraft/context-planner/intent-benchmark.json' as const;

/**
 * Persist a benchmark run so the doctor can surface accuracy without
 * re-running the fixture on every doctor invocation.
 */
export function writeBenchmarkRun(
  projectRoot: string,
  run: IIntentBenchmarkRun,
): string {
  const abs = nodePath.join(projectRoot, INTENT_BENCHMARK_RUN_REL);
  mkdirSync(nodePath.dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify(run, null, 2), 'utf8');
  return abs;
}

export function readBenchmarkRun(
  projectRoot: string,
): IIntentBenchmarkRun | undefined {
  const abs = nodePath.join(projectRoot, INTENT_BENCHMARK_RUN_REL);
  if (!existsSync(abs)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(abs, 'utf8')) as IIntentBenchmarkRun;
    if (raw.schema !== INTENT_BENCHMARK_SCHEMA) return undefined;
    return raw;
  } catch {
    return undefined;
  }
}
