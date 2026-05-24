import { describe, expect, test } from 'bun:test';
import {
  INTENT_BENCHMARK_SCHEMA,
  runIntentBenchmark,
  STARTER_INTENT_BENCHMARK,
} from '../index.ts';

describe('STARTER_INTENT_BENCHMARK', () => {
  test('declares the canonical schema and a non-trivial case set', () => {
    expect(STARTER_INTENT_BENCHMARK.schema).toBe(INTENT_BENCHMARK_SCHEMA);
    expect(STARTER_INTENT_BENCHMARK.cases.length).toBeGreaterThanOrEqual(15);
  });

  test('every case has both a task and an expected intent', () => {
    for (const c of STARTER_INTENT_BENCHMARK.cases) {
      expect(typeof c.task).toBe('string');
      expect(c.task.length).toBeGreaterThan(0);
      expect(typeof c.expected).toBe('string');
    }
  });

  test('classifier accuracy on the starter benchmark is at least 90%', () => {
    const run = runIntentBenchmark(STARTER_INTENT_BENCHMARK);
    expect(run.accuracy).toBeGreaterThanOrEqual(0.9);
  });

  test('every intent label appears at least twice', () => {
    const counts = new Map<string, number>();
    for (const c of STARTER_INTENT_BENCHMARK.cases) {
      counts.set(c.expected, (counts.get(c.expected) ?? 0) + 1);
    }
    for (const [intent, n] of counts) {
      expect(n, `intent "${intent}" should have ≥ 2 cases`).toBeGreaterThanOrEqual(2);
    }
  });
});
