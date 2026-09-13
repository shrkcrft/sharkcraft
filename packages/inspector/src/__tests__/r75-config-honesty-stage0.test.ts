/**
 * Round 11 stage 0 — two config-honesty fixes in the inspector.
 *
 *   - Readiness on an INVALID config (the file exists but failed the schema)
 *     used to report "sharkcraft.config.ts missing" as a blocker and recommend
 *     creating the file. `configFile` is null in both cases; `configLoadError`
 *     is what tells them apart, and readiness now reads it first.
 *   - `conventionFiles` is a declared config key (plugin-api documents it as a
 *     local key). A config that sets it loads — the strict schema used to reject
 *     the WHOLE config — and the convention registry reads the file it names,
 *     through the typed field rather than a cast.
 *
 * Real workspaces through the real config loader and the real inspector.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildAiReadinessReport } from '../ai-readiness.ts';
import { loadConventions } from '../convention-registry.ts';
import { inspectSharkcraft } from '../sharkcraft-inspector.ts';

const INVALID = 'sharkcraft.config.ts invalid — not loaded (see config-invalid)';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function makeProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'sc-r75-s0-'));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'r75-s0', version: '0.0.0', private: true }));
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

describe('readiness never calls an invalid config "missing"', () => {
  test('an invalid config: the note and the blocker say invalid, and nothing says "create" the file', async () => {
    const root = makeProject({
      'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'r75-s0', notARealKey: true };\n",
    });
    const inspection = await inspectSharkcraft({ cwd: root });
    expect(inspection.configLoadError).toBeDefined();
    expect(inspection.configFile).toBeNull();

    const report = buildAiReadinessReport(inspection);
    expect(report.dimensions.find((d) => d.id === 'config')?.note).toBe(INVALID);
    expect(report.verdicts.blockers).toContain(INVALID);
    expect(report.verdicts.blockers).not.toContain('sharkcraft.config.ts missing');
    expect(report.topRecommendations.some((r) => r.startsWith('Create sharkcraft/sharkcraft.config.ts'))).toBe(
      false,
    );
  });

  test('a genuinely missing config is still reported as missing', async () => {
    const root = makeProject({});
    const inspection = await inspectSharkcraft({ cwd: root });
    expect(inspection.configLoadError).toBeUndefined();
    const report = buildAiReadinessReport(inspection);
    expect(report.verdicts.blockers).toContain('sharkcraft.config.ts missing');
    expect(report.verdicts.blockers).not.toContain(INVALID);
  });
});

describe('conventionFiles is a declared, typed config key', () => {
  test('a config that sets it loads, and the registry reads the file it names', async () => {
    const root = makeProject({
      'sharkcraft/sharkcraft.config.ts':
        "export default { projectName: 'r75-s0', conventionFiles: ['more/conventions.ts'] };\n",
      'sharkcraft/more/conventions.ts':
        "export default [{ id: 'fx.naming', title: 'Naming', kind: 'naming', rules: [], severity: 'info' }];\n",
    });
    const inspection = await inspectSharkcraft({ cwd: root });
    expect(inspection.configLoadError).toBeUndefined();
    expect(inspection.config?.conventionFiles).toEqual(['more/conventions.ts']);
    const { entries } = await loadConventions(inspection);
    expect(entries.map((e) => e.convention.id)).toContain('fx.naming');
  });

  test('a pack-manifest-only key is still rejected in local config (the deleted reads were unreachable)', async () => {
    const root = makeProject({
      'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'r75-s0', helperFiles: ['h.ts'] };\n",
    });
    const inspection = await inspectSharkcraft({ cwd: root });
    expect(inspection.configLoadError).toBeDefined();
  });
});
