import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLAN_CACHE_SCHEMA, PlanCache, encodeEmbedding } from '@shrkcrft/embeddings';

let tempRepo = '';

beforeEach(() => {
  tempRepo = mkdtempSync(join(tmpdir(), 'shrk-plan-cache-'));
});

afterEach(() => {
  rmSync(tempRepo, { recursive: true, force: true });
});

function unit(values: number[]): Float32Array {
  const v = new Float32Array(values);
  let mag = 0;
  for (const x of v) mag += x * x;
  mag = Math.sqrt(mag);
  for (let i = 0; i < v.length; i += 1) v[i] = v[i]! / mag;
  return v;
}

function entryFor(task: string, vec: Float32Array): {
  schema: typeof PLAN_CACHE_SCHEMA;
  task: string;
  taskSlug: string;
  model: string;
  embeddingDimensions: number;
  embeddingB64: string;
  plan: {
    summary: string;
    taskUnderstanding: string;
    likelyTechnicalApproach: string;
    handoffSummary: string;
  };
  savedAt: string;
} {
  return {
    schema: PLAN_CACHE_SCHEMA,
    task,
    taskSlug: task.toLowerCase().replace(/\s+/g, '-'),
    model: 'fake/embed',
    embeddingDimensions: vec.length,
    embeddingB64: encodeEmbedding(vec),
    plan: {
      summary: `plan for ${task}`,
      taskUnderstanding: 'understood',
      likelyTechnicalApproach: 'approach',
      handoffSummary: 'handoff',
    },
    savedAt: new Date().toISOString(),
  };
}

describe('PlanCache', () => {
  test('all() returns empty when no cache file exists', () => {
    expect(PlanCache.all(tempRepo)).toEqual([]);
  });

  test('append + all() round-trip', () => {
    const e1 = entryFor('add ollama provider', unit([1, 0, 0, 0]));
    const e2 = entryFor('improve smart-context', unit([0, 1, 0, 0]));
    PlanCache.append(tempRepo, e1);
    PlanCache.append(tempRepo, e2);
    const all = PlanCache.all(tempRepo);
    expect(all.length).toBe(2);
    expect(all[0]?.task).toBe('add ollama provider');
    expect(all[1]?.task).toBe('improve smart-context');
    // File is JSONL-formatted (newline separated)
    const body = readFileSync(join(tempRepo, '.sharkcraft/smart-context/cache/plans.jsonl'), 'utf8');
    expect(body.split('\n').filter((l) => l.length > 0).length).toBe(2);
  });

  test('findSimilar() ranks by cosine and respects the model filter', () => {
    PlanCache.append(tempRepo, entryFor('add ollama provider', unit([1, 0, 0, 0])));
    PlanCache.append(tempRepo, entryFor('rewrite renderer', unit([0, 1, 0, 0])));
    PlanCache.append(tempRepo, entryFor('add another ai provider', unit([0.99, 0.14, 0, 0])));

    const query = unit([1, 0, 0, 0]);
    const hits = PlanCache.findSimilar(tempRepo, query, { model: 'fake/embed', k: 3 });
    expect(hits.length).toBe(3);
    expect(hits[0]?.entry.task).toBe('add ollama provider');
    expect(hits[0]!.similarity).toBeCloseTo(1, 5);
    expect(hits[1]?.entry.task).toBe('add another ai provider');
    expect(hits[1]!.similarity).toBeGreaterThan(hits[2]!.similarity);
  });

  test('findSimilar() ignores entries with a different model', () => {
    PlanCache.append(tempRepo, entryFor('something else', unit([1, 0, 0, 0])));
    const hits = PlanCache.findSimilar(tempRepo, unit([1, 0, 0, 0]), { model: 'other/model', k: 3 });
    expect(hits).toEqual([]);
  });

  test('findSimilar() respects minSimilarity threshold', () => {
    PlanCache.append(tempRepo, entryFor('high sim', unit([1, 0, 0, 0])));
    PlanCache.append(tempRepo, entryFor('low sim', unit([0, 1, 0, 0])));
    const hits = PlanCache.findSimilar(tempRepo, unit([1, 0, 0, 0]), {
      model: 'fake/embed',
      k: 5,
      minSimilarity: 0.5,
    });
    expect(hits.length).toBe(1);
    expect(hits[0]?.entry.task).toBe('high sim');
  });

  test('all() skips malformed JSONL lines and entries with wrong schema', () => {
    const e = entryFor('valid', unit([1, 0, 0, 0]));
    PlanCache.append(tempRepo, e);
    // Manually append a bogus line and an off-schema entry
    const path = join(tempRepo, '.sharkcraft/smart-context/cache/plans.jsonl');
    const body = readFileSync(path, 'utf8');
    const corrupt =
      body +
      'not-json\n' +
      JSON.stringify({ schema: 'wrong', task: 'x', embeddingB64: '' }) +
      '\n';
    require('node:fs').writeFileSync(path, corrupt);
    const all = PlanCache.all(tempRepo);
    expect(all.length).toBe(1);
    expect(all[0]?.task).toBe('valid');
  });

  test('write() replaces the cache contents wholesale', () => {
    PlanCache.append(tempRepo, entryFor('old', unit([1, 0, 0, 0])));
    PlanCache.write(tempRepo, [entryFor('new', unit([0, 1, 0, 0]))]);
    const all = PlanCache.all(tempRepo);
    expect(all.length).toBe(1);
    expect(all[0]?.task).toBe('new');
    expect(existsSync(join(tempRepo, '.sharkcraft/smart-context/cache/plans.jsonl'))).toBe(true);
  });
});
