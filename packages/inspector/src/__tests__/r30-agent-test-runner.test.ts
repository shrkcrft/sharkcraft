/**
 * Strict expectation fields on agent contract tests.
 */
import { describe, expect, test } from 'bun:test';
import { inspectSharkcraft } from '../sharkcraft-inspector.ts';
import {
  loadAgentContractRegistries as loader,
  runAgentContractTest as runner,
} from '../test-runner.ts';

const cwd = process.cwd();

describe('strict agent contract expectations', () => {
  test('missing expected helper id fails the test', async () => {
    const inspection = await inspectSharkcraft({ cwd });
    const registries = await loader(inspection);
    const r = runner(
      inspection,
      {
        id: 'sanity-missing-helper',
        task: 'create something',
        expectedHelpers: ['demo.does-not-exist'],
      },
      registries,
    );
    expect(r.passed).toBe(false);
    expect(r.missingHelpers).toEqual(['demo.does-not-exist']);
  });

  test('missing expected policy id fails the test', async () => {
    const inspection = await inspectSharkcraft({ cwd });
    const registries = await loader(inspection);
    const r = runner(
      inspection,
      {
        id: 'sanity-missing-policy',
        task: 'create something',
        expectedPolicies: ['sharkcraft.does-not-exist'],
      },
      registries,
    );
    expect(r.passed).toBe(false);
    expect(r.missingPolicies).toEqual(['sharkcraft.does-not-exist']);
  });

  test('present expected knowledge id passes the test', async () => {
    const inspection = await inspectSharkcraft({ cwd });
    const registries = await loader(inspection);
    const r = runner(
      inspection,
      {
        id: 'sanity-knowledge-ok',
        task: 'fix a boundary issue introduced in my changed files only',
        expectedKnowledge: ['engine.changed-only-boundaries'],
      },
      registries,
    );
    expect(r.passed).toBe(true);
  });

  test('mustNotInclude catches ranker drift toward forbidden id', async () => {
    const inspection = await inspectSharkcraft({ cwd });
    const registries = await loader(inspection);
    const r = runner(
      inspection,
      {
        id: 'sanity-mustnotinclude',
        task: 'add a new CLI command',
        mustNotInclude: ['engine.cli-command'],
      },
      registries,
    );
    expect(r.passed).toBe(false);
    expect(r.unexpectedlyIncluded).toContain('engine.cli-command');
  });

  test('all self agent tests pass with strict expectations', async () => {
    const inspection = await inspectSharkcraft({ cwd });
    const registries = await loader(inspection);
    const { loadAgentContractTests } = await import('../test-runner.ts');
    const tests = await loadAgentContractTests(inspection);
    const results = tests.map((t) => runner(inspection, t, registries));
    const failed = results.filter((r) => !r.passed);
    if (failed.length > 0) {
      // Print which one failed and why for easy debugging.
      for (const f of failed) {
        process.stderr.write(`agent test ${f.id} failed: ${f.failureSummary ?? '(no summary)'}\n`);
      }
    }
    expect(failed).toHaveLength(0);
  });
});
