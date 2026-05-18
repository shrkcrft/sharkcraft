import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { renderImpactGraphSvg } from '../impact-graph-render.ts';

describe('r15 optional impact-graph SVG render', () => {
  test('degrades gracefully when renderer is missing', async () => {
    const dir = mkdtempSync(nodePath.join(tmpdir(), 'sharkcraft-r15-svg-'));
    const src = nodePath.join(dir, 'impact-1.mmd');
    writeFileSync(src, 'flowchart LR\n  A --> B\n', 'utf8');
    const result = await renderImpactGraphSvg(
      { sourceFile: src, svgFile: nodePath.join(dir, 'impact-1.svg'), format: 'mermaid' },
      { override: { mmdc: null } },
    );
    expect(result.rendered).toBe(false);
    expect(result.reason).toBe('renderer-missing');
    expect(result.renderer).toBeNull();
  });

  test('returns source-missing when input file is absent', async () => {
    const dir = mkdtempSync(nodePath.join(tmpdir(), 'sharkcraft-r15-svg2-'));
    const result = await renderImpactGraphSvg(
      {
        sourceFile: nodePath.join(dir, 'does-not-exist.mmd'),
        svgFile: nodePath.join(dir, 'out.svg'),
        format: 'mermaid',
      },
      { override: { mmdc: null } },
    );
    expect(result.rendered).toBe(false);
    expect(result.reason).toBe('source-missing');
  });

  test('renderer-failed when an injected binary exists but bails', async () => {
    const dir = mkdtempSync(nodePath.join(tmpdir(), 'sharkcraft-r15-svg3-'));
    const src = nodePath.join(dir, 'impact-1.dot');
    writeFileSync(src, 'digraph { A -> B }\n', 'utf8');
    // Use /bin/false as a renderer — it always exits non-zero.
    const result = await renderImpactGraphSvg(
      { sourceFile: src, svgFile: nodePath.join(dir, 'impact-1.svg'), format: 'dot' },
      { override: { dot: '/bin/false' } },
    );
    expect(result.rendered).toBe(false);
    expect(result.reason).toBe('renderer-failed');
    expect(result.renderer).toBe('dot');
  });
});
