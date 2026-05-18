import { describe, expect, test } from 'bun:test';
import * as nodePath from 'node:path';
import {
  analyzeImpact,
  inspectSharkcraft,
  renderImpactDot,
  renderImpactMermaid,
} from '../index.ts';

const DOGFOOD_CWD = nodePath.resolve(__dirname, '../../../../examples/dogfood-target');

describe('r13 impact graph export', () => {
  test('mermaid contains flowchart + node + class', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD_CWD });
    const impact = await analyzeImpact(inspection, {
      files: ['src/services/user.service.ts'],
    });
    const mmd = renderImpactMermaid(impact);
    expect(mmd).toContain('flowchart LR');
    expect(mmd).toContain('classDef risk-warn');
    expect(mmd).toMatch(/n\d+\["src\/services\/user\.service\.ts"\]/);
  });

  test('dot contains digraph + node + colored root', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD_CWD });
    const impact = await analyzeImpact(inspection, {
      files: ['src/services/user.service.ts'],
    });
    const dot = renderImpactDot(impact);
    expect(dot).toContain('digraph ImpactTree {');
    expect(dot).toContain('rankdir=LR');
    expect(dot).toContain('src/services/user.service.ts');
  });

  test('escaping handles quotes in file names', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD_CWD });
    const impact = await analyzeImpact(inspection, {
      files: ['src/x"weird".ts'],
    });
    const mmd = renderImpactMermaid(impact);
    expect(mmd).toContain('\\"');
  });

  test('truncation marker appears when transitive list was truncated', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD_CWD });
    const impact = await analyzeImpact(inspection, {
      files: ['src/services/user.service.ts'],
    });
    const truncatedImpact = {
      ...impact,
      truncations: [{ list: 'transitiveDependents', total: 10, shown: 3 }],
    } as typeof impact;
    const mmd = renderImpactMermaid(truncatedImpact);
    expect(mmd).toContain('more dependents omitted');
  });
});
