import { describe, expect, test } from 'bun:test';
import { buildRepositoryMap, inspectSharkcraft, renderRepositoryMap } from '../index.ts';

describe('r16 repository map', () => {
  test('builds a map of the SharkCraft repo itself', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const map = await buildRepositoryMap(inspection);
    expect(map.rootSummary.name).toBe('sharkcraft');
    expect(map.packages.length).toBeGreaterThanOrEqual(5);
    expect(map.constructs.some((c) => c.kind === 'rule')).toBe(true);
    const txt = renderRepositoryMap(map, 'text');
    expect(txt).toContain('Repository map');
    const md = renderRepositoryMap(map, 'markdown');
    expect(md).toContain('## Packages');
    const html = renderRepositoryMap(map, 'html');
    expect(html).toContain('<title>');
    expect(html.includes('<script')).toBe(false);
  });
});
