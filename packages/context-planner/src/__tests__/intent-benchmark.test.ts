import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  INTENT_BENCHMARK_SCHEMA,
  loadIntentBenchmark,
  readBenchmarkRun,
  runIntentBenchmark,
  writeBenchmarkRun,
  type IIntentBenchmark,
} from '../intent/benchmark.ts';

describe('intent benchmark', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'shrk-intent-bench-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function fixture(cases: IIntentBenchmark['cases']): IIntentBenchmark {
    return { schema: INTENT_BENCHMARK_SCHEMA, cases };
  }

  test('loadIntentBenchmark returns undefined when fixture is missing', () => {
    expect(loadIntentBenchmark(root)).toBeUndefined();
  });

  test('loadIntentBenchmark returns the fixture when present', () => {
    mkdirSync(join(root, 'sharkcraft'), { recursive: true });
    writeFileSync(
      join(root, 'sharkcraft', 'intent-benchmark.json'),
      JSON.stringify(fixture([{ task: 'fix the login bug', expected: 'bug-fix' }])),
    );
    const b = loadIntentBenchmark(root);
    expect(b?.cases).toHaveLength(1);
  });

  test('loadIntentBenchmark rejects payload with the wrong schema', () => {
    mkdirSync(join(root, 'sharkcraft'), { recursive: true });
    writeFileSync(
      join(root, 'sharkcraft', 'intent-benchmark.json'),
      JSON.stringify({ schema: 'sharkcraft.intent-benchmark/v9', cases: [] }),
    );
    expect(loadIntentBenchmark(root)).toBeUndefined();
  });

  test('runIntentBenchmark scores classification against expected labels', () => {
    const b = fixture([
      { task: 'fix the broken login flow', expected: 'bug-fix' },
      { task: 'add a new dashboard widget', expected: 'feature' },
      { task: 'update the README', expected: 'docs' },
      { task: 'rename internal helpers', expected: 'refactor' },
      // Forced miss: classifier won't pick "release" from this phrasing.
      { task: 'normal day on the project', expected: 'release' },
    ]);
    const r = runIntentBenchmark(b);
    expect(r.total).toBe(5);
    expect(r.passed).toBe(4);
    expect(r.failed).toBe(1);
    expect(r.accuracy).toBeCloseTo(0.8);
    expect(r.cases.find((c) => c.expected === 'release')?.passed).toBe(false);
  });

  test('runIntentBenchmark handles an empty case list as 100% accurate', () => {
    const r = runIntentBenchmark(fixture([]));
    expect(r.total).toBe(0);
    expect(r.accuracy).toBe(1);
  });

  test('writeBenchmarkRun + readBenchmarkRun round-trip', () => {
    const r = runIntentBenchmark(
      fixture([{ task: 'add a feature', expected: 'feature' }]),
    );
    const path = writeBenchmarkRun(root, r);
    expect(existsSync(path)).toBe(true);
    expect(path.endsWith('.sharkcraft/context-planner/intent-benchmark.json')).toBe(true);
    const round = readBenchmarkRun(root);
    expect(round?.total).toBe(1);
    expect(round?.passed).toBe(1);
  });
});
