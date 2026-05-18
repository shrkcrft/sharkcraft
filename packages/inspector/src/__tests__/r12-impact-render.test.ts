import { describe, expect, test } from 'bun:test';
import * as nodePath from 'node:path';
import {
  analyzeImpact,
  buildImpactTree,
  inspectSharkcraft,
  renderImpactHtml,
  renderImpactMarkdown,
  renderImpactText,
} from '../index.ts';

const DOGFOOD_CWD = nodePath.resolve(__dirname, '../../../../examples/dogfood-target');

describe('r12 impact renderers', () => {
  test('markdown contains risk + dependents + tests', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD_CWD });
    const impact = await analyzeImpact(inspection, { files: ['src/services/user.service.ts'] });
    const md = renderImpactMarkdown(impact);
    expect(md).toContain('Risk:');
    expect(md).toContain('## Direct dependents');
    expect(md).toContain('## Suggested tests');
  });

  test('html contains risk badge + escaped output', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD_CWD });
    const impact = await analyzeImpact(inspection, { files: ['src/services/user.service.ts'] });
    const html = renderImpactHtml(impact);
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('class="tag');
    // No script tag.
    expect(html.toLowerCase()).not.toContain('<script');
  });

  test('text + tree output contains target', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD_CWD });
    const impact = await analyzeImpact(inspection, { files: ['src/services/user.service.ts'] });
    const text = renderImpactText(impact);
    expect(text).toContain('Dependency tree');
    expect(text).toContain('src/services/user.service.ts');
  });

  test('buildImpactTree returns rooted nodes', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD_CWD });
    const impact = await analyzeImpact(inspection, { files: ['src/services/user.service.ts'] });
    const tree = buildImpactTree(impact);
    expect(tree.length).toBeGreaterThan(0);
    expect(tree[0]!.file).toBe('src/services/user.service.ts');
  });
});
