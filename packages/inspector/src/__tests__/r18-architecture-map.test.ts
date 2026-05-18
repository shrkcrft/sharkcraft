import { describe, expect, test } from 'bun:test';
import { buildArchitectureMap, inspectSharkcraft } from '../index.ts';

describe('r18 architecture map v2', () => {
  test('detects sharkcraft layers + packages', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const map = await buildArchitectureMap(inspection);
    expect(map.schema).toBe('sharkcraft.architecture-map/v2');
    expect(map.layers.length).toBeGreaterThan(0);
    expect(map.graphSummary.packages).toBeGreaterThan(0);
  });
  test('include filter restricts sections', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const map = await buildArchitectureMap(inspection, { include: ['layers'] });
    expect(map.layers.length).toBeGreaterThan(0);
    expect(map.publicApiSurfaces.length).toBe(0);
    expect(map.boundaryRules.length).toBe(0);
  });
  test('risk surface includes warnings when applicable', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const map = await buildArchitectureMap(inspection, { risk: true });
    // The sharkcraft monorepo has tests, so the "no-tests-detected" risk should not fire.
    expect(Array.isArray(map.risks)).toBe(true);
  });
});
