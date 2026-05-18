import { describe, expect, test } from 'bun:test';
import * as nodePath from 'node:path';
import {
  explainSearchTuning,
  inspectSharkcraft,
  renderTuningExplainHtml,
  renderTuningExplainMarkdown,
} from '../index.ts';

const DOGFOOD_CWD = nodePath.resolve(__dirname, '../../../../examples/dogfood-target');

describe('r13 search tuning explain', () => {
  test('returns tokens + empty loadedTunings when none configured', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD_CWD });
    const report = await explainSearchTuning(inspection, 'service');
    expect(report.tokens).toContain('service');
    // dogfood-target ships no tuning files
    expect(report.loadedTunings.length).toBe(0);
  });

  test('renders helpful markdown when empty', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD_CWD });
    const report = await explainSearchTuning(inspection, 'service');
    const md = renderTuningExplainMarkdown(report);
    expect(md).toContain('Loaded tunings (0)');
  });

  test('renders html with no script tag', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD_CWD });
    const report = await explainSearchTuning(inspection, 'service');
    const html = renderTuningExplainHtml(report);
    expect(html.toLowerCase()).not.toContain('<script');
    expect(html).toContain('Search tuning explain');
  });
});
