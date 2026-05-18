import { describe, expect, test } from 'bun:test';
import * as nodePath from 'node:path';
import { inspectSharkcraft } from '../sharkcraft-inspector.ts';

const DOGFOOD = nodePath.resolve(__dirname, '../../../../examples/dogfood-target');

describe('pack resolved contribution counts', () => {
  test('@example/sharkcraft-pack-example reports resolved counts after dedup', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD });
    const pack = inspection.packs.discoveredPacks.find(
      (p) => p.packageName === '@example/sharkcraft-pack-example',
    );
    expect(pack).toBeDefined();
    expect(pack?.resolvedCounts).toBeDefined();
    const r = pack!.resolvedCounts!;
    // Sums are non-negative and reflect at least one of each contribution kind.
    expect(r.templates).toBeGreaterThanOrEqual(1);
    expect(r.pipelines).toBeGreaterThanOrEqual(1);
    // Total resolved knowledge >= 1 (the pack carries knowledge + rules + paths).
    const totalEntries = r.knowledgeEntries + r.rules + r.pathConventions;
    expect(totalEntries).toBeGreaterThanOrEqual(1);
  });

  test('contribution file counts match what manifest declared', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD });
    const pack = inspection.packs.discoveredPacks.find(
      (p) => p.packageName === '@example/sharkcraft-pack-example',
    );
    expect(pack).toBeDefined();
    const c = pack!.contributionCounts;
    expect(c.knowledgeFiles).toBe(1);
    expect(c.ruleFiles).toBe(1);
    expect(c.pathFiles).toBe(1);
    expect(c.templateFiles).toBe(1);
    expect(c.pipelineFiles).toBe(1);
    expect(c.docsFiles).toBe(1);
  });
});
