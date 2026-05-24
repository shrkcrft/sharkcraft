import {
  loadIntentBenchmark,
  readBenchmarkRun,
} from '@shrkcrft/context-planner';
import type { IToolDefinition } from '../server/tool-definition.ts';

/**
 * Read-only MCP surface for the intent-classifier benchmark. Returns
 * the latest persisted run + a hint about the source fixture so the
 * agent can correlate misses against the labelled cases.
 *
 * When no run is on disk but a fixture is present, the tool reports
 * `state: 'fixture-only'` and points at `shrk context benchmark` so
 * the run can be created without an additional turn of guessing.
 */
export const getIntentBenchmarkRunTool: IToolDefinition = {
  name: 'get_intent_benchmark_run',
  description:
    'Return the most recent intent-classifier benchmark run. Read-only mirror of `shrk context benchmark`.',
  cliCommand: 'context benchmark',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  handler(_input, ctx) {
    const root = ctx.inspection.projectRoot;
    const fixture = loadIntentBenchmark(root);
    const run = readBenchmarkRun(root);
    if (!fixture && !run) {
      return {
        data: {
          schema: 'sharkcraft.intent-benchmark/v1',
          state: 'missing',
          fixture: null,
          run: null,
          nextCommands: ['shrk context benchmark seed', 'shrk context benchmark'],
        },
      };
    }
    if (!run) {
      return {
        data: {
          schema: 'sharkcraft.intent-benchmark/v1',
          state: 'fixture-only',
          fixtureCaseCount: fixture?.cases.length ?? 0,
          run: null,
          nextCommands: ['shrk context benchmark'],
        },
      };
    }
    return {
      data: {
        schema: 'sharkcraft.intent-benchmark/v1',
        state: 'present',
        fixtureCaseCount: fixture?.cases.length ?? run.total,
        run,
      },
    };
  },
};
