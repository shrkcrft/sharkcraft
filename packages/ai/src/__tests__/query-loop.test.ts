import { describe, expect, test } from 'bun:test';
import { AppErrorImpl, ERROR_CODES, err, ok, type AppError, type Result } from '@shrkcrft/core';
import type { IAiProvider } from '../ai-provider.ts';
import type { IAiRequest, IAiResponse } from '../ai-request.ts';
import { runBoundedQueryLoop, type QueryExecutor } from '../delegate/query-loop.ts';

/** A provider that returns a scripted content per call. */
function scriptedProvider(contents: string[]): { provider: IAiProvider; calls: IAiRequest[] } {
  const calls: IAiRequest[] = [];
  let i = 0;
  const provider: IAiProvider = {
    id: 's',
    name: 's',
    configure() {},
    isReady() {
      return true;
    },
    async send(req: IAiRequest): Promise<Result<IAiResponse, AppError>> {
      calls.push(req);
      const c = contents[Math.min(i, contents.length - 1)] ?? '';
      i += 1;
      return ok({ content: c, model: 'm' });
    },
  };
  return { provider, calls };
}

function recordingExecutor(map: Record<string, { content: string; entities: string[] }>): {
  exec: QueryExecutor;
  names: string[];
} {
  const names: string[] = [];
  const exec: QueryExecutor = async (name) => {
    names.push(name);
    return map[name] ?? { content: 'n/a', entities: [] };
  };
  return { exec, names };
}

const base = {
  messages: [{ role: 'user', content: 'analyze' } as never],
  finalInstruction: 'now answer',
  finalResponseFormat: { type: 'json_schema' as const, schema: {}, schemaName: 'X' },
};

describe('runBoundedQueryLoop', () => {
  test('runs an allow-listed query, then produces the final answer', async () => {
    const { provider } = scriptedProvider([
      '{"done":false,"queries":[{"name":"coverage","args":{}}]}',
      '{"findings":[]}',
    ]);
    const { exec, names } = recordingExecutor({ coverage: { content: 'overall 50%', entities: ['cov-cat'] } });
    const res = await runBoundedQueryLoop({
      ...base,
      provider,
      allowedQueries: ['coverage'],
      maxQueryRounds: 1,
      executeQuery: exec,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.content).toBe('{"findings":[]}');
      expect(res.value.roundsRun).toBe(1);
      expect(res.value.gatheredEntities).toContain('cov-cat');
      expect(res.value.degraded).toBe(false);
      expect(names).toEqual(['coverage']);
    }
  });

  test('a query outside the allow-list is refused — the executor is never called for it', async () => {
    const { provider } = scriptedProvider([
      '{"done":false,"queries":[{"name":"test-impact","args":{}}]}',
      '{"findings":[]}',
    ]);
    const { exec, names } = recordingExecutor({ 'test-impact': { content: 'x', entities: ['leak'] } });
    const res = await runBoundedQueryLoop({
      ...base,
      provider,
      allowedQueries: ['coverage'], // test-impact NOT allowed
      maxQueryRounds: 1,
      executeQuery: exec,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(names).toEqual([]); // executor never invoked for the disallowed query
      expect(res.value.queries[0]?.ok).toBe(false);
      expect(res.value.gatheredEntities).toEqual([]);
    }
  });

  test('maxQueryRounds 0 goes straight to the answer (degraded, no queries)', async () => {
    const { provider, calls } = scriptedProvider(['{"findings":[]}']);
    const { exec, names } = recordingExecutor({});
    const res = await runBoundedQueryLoop({
      ...base,
      provider,
      allowedQueries: ['coverage'],
      maxQueryRounds: 0,
      executeQuery: exec,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.roundsRun).toBe(0);
      expect(res.value.degraded).toBe(true);
      expect(names).toEqual([]);
    }
    expect(calls).toHaveLength(1); // only the final answer call
  });

  test('the model can decline to query (done:true) and answer immediately', async () => {
    const { provider } = scriptedProvider(['{"done":true}', '{"findings":[]}']);
    const { exec } = recordingExecutor({});
    const res = await runBoundedQueryLoop({
      ...base,
      provider,
      allowedQueries: ['coverage'],
      maxQueryRounds: 3,
      executeQuery: exec,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.queries).toEqual([]);
      expect(res.value.degraded).toBe(true);
    }
  });

  test('the wall-clock budget bounds the number of rounds', async () => {
    const clock = [0, 50, 200, 300, 400];
    let k = 0;
    const now = () => clock[Math.min(k++, clock.length - 1)]!;
    const { provider } = scriptedProvider([
      '{"done":false,"queries":[{"name":"coverage","args":{}}]}',
      '{"done":false,"queries":[{"name":"coverage","args":{}}]}',
      '{"findings":[]}',
    ]);
    const { exec, names } = recordingExecutor({ coverage: { content: 'c', entities: [] } });
    const res = await runBoundedQueryLoop({
      ...base,
      provider,
      allowedQueries: ['coverage'],
      maxQueryRounds: 3,
      budgetMs: 100,
      now,
      executeQuery: exec,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.roundsRun).toBe(1); // 2nd round's budget check (200>100) breaks
    expect(names).toEqual(['coverage']);
  });

  test('a provider error surfaces as err', async () => {
    const provider: IAiProvider = {
      id: 'e',
      name: 'e',
      configure() {},
      isReady() {
        return true;
      },
      async send(): Promise<Result<IAiResponse, AppError>> {
        return err(new AppErrorImpl(ERROR_CODES.IO_ERROR, 'boom'));
      },
    };
    const res = await runBoundedQueryLoop({
      ...base,
      provider,
      allowedQueries: ['coverage'],
      maxQueryRounds: 1,
      executeQuery: async () => ({ content: '', entities: [] }),
    });
    expect(res.ok).toBe(false);
  });
});
