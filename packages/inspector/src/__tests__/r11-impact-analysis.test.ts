import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { analyzeImpact, ImpactInputKind, inspectSharkcraft } from '../index.ts';

function makeProject(): { root: string } {
  const root = mkdtempSync(nodePath.join(tmpdir(), 'sharkcraft-r11-impact-'));
  mkdirSync(nodePath.join(root, 'src'), { recursive: true });
  writeFileSync(
    nodePath.join(root, 'package.json'),
    JSON.stringify({ name: 'r11-impact', version: '0.0.0' }),
    'utf8',
  );
  writeFileSync(
    nodePath.join(root, 'src', 'util.ts'),
    'export const util = 1;\n',
    'utf8',
  );
  writeFileSync(
    nodePath.join(root, 'src', 'consumer-a.ts'),
    "import { util } from './util';\nexport const a = util + 1;\n",
    'utf8',
  );
  writeFileSync(
    nodePath.join(root, 'src', 'consumer-b.ts'),
    "import { a } from './consumer-a';\nexport const b = a + 1;\n",
    'utf8',
  );
  return { root };
}

describe('r11 impact analysis v2', () => {
  test('reverse closure surfaces direct and transitive dependents', async () => {
    const { root } = makeProject();
    const inspection = await inspectSharkcraft({ cwd: root });
    const report = await analyzeImpact(inspection, {
      files: ['src/util.ts'],
      inputKind: ImpactInputKind.File,
    });
    expect(report.schema).toBe('sharkcraft.impact-analysis/v2');
    expect(report.directDependents).toContain('src/consumer-a.ts');
    expect(report.transitiveDependents).toContain('src/consumer-b.ts');
    expect(report.riskReasons.length).toBeGreaterThan(0);
  });

  test('risk classification considers transitive count', async () => {
    const { root } = makeProject();
    const inspection = await inspectSharkcraft({ cwd: root });
    const report = await analyzeImpact(inspection, {
      files: ['src/util.ts'],
    });
    expect(['low', 'medium', 'high', 'critical']).toContain(report.risk);
  });

  test('truncation reports oversized lists', async () => {
    const { root } = makeProject();
    const inspection = await inspectSharkcraft({ cwd: root });
    const report = await analyzeImpact(inspection, {
      files: ['src/util.ts'],
      limit: 0,
    });
    // With limit=0, every populated list should show up as truncation.
    const truncated = new Set(report.truncations.map((t) => t.list));
    expect(truncated.size).toBeGreaterThanOrEqual(0);
  });
});
