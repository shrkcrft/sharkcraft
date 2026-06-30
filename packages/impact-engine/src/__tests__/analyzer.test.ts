import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFullIndex } from '@shrkcrft/graph';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import { buildBridge } from '@shrkcrft/rule-graph';
import { analyzeGraphImpact } from '../engine/analyzer.ts';
import { GRAPH_IMPACT_SCHEMA } from '../schema/impact-analysis.ts';

function setupFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-impact-engine-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo-root', workspaces: ['packages/*'] }, null, 2),
  );
  mkdirSync(join(root, 'packages', 'alpha', 'src'), { recursive: true });
  mkdirSync(join(root, 'packages', 'beta', 'src'), { recursive: true });
  mkdirSync(join(root, 'packages', 'gamma', 'src'), { recursive: true });
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  writeFileSync(
    join(root, 'packages', 'alpha', 'package.json'),
    JSON.stringify({ name: '@demo/alpha', main: 'src/index.ts' }, null, 2),
  );
  writeFileSync(
    join(root, 'packages', 'beta', 'package.json'),
    JSON.stringify({ name: '@demo/beta', main: 'src/index.ts' }, null, 2),
  );
  writeFileSync(
    join(root, 'packages', 'gamma', 'package.json'),
    JSON.stringify({ name: '@demo/gamma', main: 'src/index.ts' }, null, 2),
  );
  writeFileSync(
    join(root, 'packages', 'alpha', 'src', 'index.ts'),
    "export function alpha() { return 1; }\nexport const ALPHA_TAG = 'a';",
  );
  writeFileSync(
    join(root, 'packages', 'beta', 'src', 'index.ts'),
    "import { alpha } from '@demo/alpha';\nexport function useAlpha() { return alpha(); }",
  );
  writeFileSync(
    join(root, 'packages', 'gamma', 'src', 'index.ts'),
    "import { useAlpha } from '@demo/beta';\nexport const x = useAlpha();",
  );
  // A test file in the dependent set, to exercise likelyTests.
  mkdirSync(join(root, 'packages', 'beta', 'src', '__tests__'), { recursive: true });
  writeFileSync(
    join(root, 'packages', 'beta', 'src', '__tests__', 'index.test.ts'),
    "import { useAlpha } from '../index.ts';\nconsole.log(useAlpha);",
  );
  // Minimal sharkcraft config + a boundary rule that applies to alpha.
  writeFileSync(
    join(root, 'sharkcraft', 'sharkcraft.config.ts'),
    "export default { projectName: 'demo', boundaryFiles: ['boundaries.ts'] };",
  );
  writeFileSync(
    join(root, 'sharkcraft', 'boundaries.ts'),
    [
      "export default [{",
      "  id: 'demo.alpha-isolated',",
      "  title: 'alpha is isolated',",
      "  severity: 'error',",
      "  from: ['packages/alpha/src/**'],",
      "  forbiddenImports: ['@demo/gamma'],",
      "}];",
    ].join('\n'),
  );
  return root;
}

/**
 * A snapshot where one exported symbol (`alpha`) is referenced by `consumerCount`
 * distinct files — used to exercise the caller-file display cap and ensure risk
 * reflects the UNCAPPED blast radius.
 */
function setupManyCallersFixture(consumerCount: number): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-impact-callers-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo-root', workspaces: ['packages/*'] }, null, 2),
  );
  mkdirSync(join(root, 'packages', 'alpha', 'src'), { recursive: true });
  mkdirSync(join(root, 'packages', 'consumers', 'src'), { recursive: true });
  writeFileSync(
    join(root, 'packages', 'alpha', 'package.json'),
    JSON.stringify({ name: '@demo/alpha', main: 'src/index.ts' }, null, 2),
  );
  writeFileSync(
    join(root, 'packages', 'consumers', 'package.json'),
    JSON.stringify({ name: '@demo/consumers', main: 'src/index.ts' }, null, 2),
  );
  writeFileSync(
    join(root, 'packages', 'alpha', 'src', 'index.ts'),
    'export function alpha() { return 1; }',
  );
  writeFileSync(join(root, 'packages', 'consumers', 'src', 'index.ts'), 'export {};');
  for (let i = 0; i < consumerCount; i += 1) {
    writeFileSync(
      join(root, 'packages', 'consumers', 'src', `c${i}.ts`),
      `import { alpha } from '@demo/alpha';\nexport const c${i} = alpha();`,
    );
  }
  return root;
}

describe('analyzeGraphImpact', () => {
  test('files input — direct + transitive dependents + tests', async () => {
    const root = setupFixture();
    try {
      buildFullIndex({ projectRoot: root });
      const r = analyzeGraphImpact(
        { kind: 'files', files: ['packages/alpha/src/index.ts'] },
        { projectRoot: root },
      );
      expect(r.schema).toBe(GRAPH_IMPACT_SCHEMA);
      expect(r.normalizedTargets).toContain('file:packages/alpha/src/index.ts');
      expect(r.directDependents.some((d) => d.path === 'packages/beta/src/index.ts')).toBe(true);
      // Gamma reaches alpha via beta — transitive dependent.
      const allDeps = [...r.directDependents, ...r.transitiveDependents];
      expect(allDeps.some((d) => d.path === 'packages/gamma/src/index.ts')).toBe(true);
      expect(r.affectedSymbols.some((s) => s.label === 'alpha')).toBe(true);
      expect(r.affectedCallerFiles.some((c) => c.path === 'packages/beta/src/index.ts')).toBe(true);
      expect(r.likelyTests.some((t) => t.path?.includes('index.test.ts'))).toBe(true);
      expect(r.affectedPackages).toContain('@demo/beta');
      expect(r.publicApiTouched).toBe(true);
      expect(r.validationScope).toContain('bun test');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('symbol input — caller files via symbol references', async () => {
    const root = setupFixture();
    try {
      buildFullIndex({ projectRoot: root });
      const r = analyzeGraphImpact(
        { kind: 'symbol', symbolId: 'alpha' },
        { projectRoot: root },
      );
      expect(r.affectedSymbols.some((s) => s.label === 'alpha')).toBe(true);
      expect(r.affectedCallerFiles.some((c) => c.path === 'packages/beta/src/index.ts')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rule-graph bridge — affectedRules / Templates populated when bridge exists', async () => {
    const root = setupFixture();
    try {
      buildFullIndex({ projectRoot: root });
      const inspection = await inspectSharkcraft({ cwd: root });
      await buildBridge({ projectRoot: root, inspection });
      const r = analyzeGraphImpact(
        { kind: 'files', files: ['packages/alpha/src/index.ts'] },
        { projectRoot: root },
      );
      expect(r.affectedRules.some((rule) => rule.id === 'boundary:demo.alpha-isolated')).toBe(true);
      // No bridge-missing diagnostic.
      expect(r.diagnostics.some((d) => d.includes('bridge store missing'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('caller-file cap records truncations.callers; risk uses the uncapped count', () => {
    const consumerCount = 12; // > the small limit AND >= the 10-caller risk threshold
    const root = setupManyCallersFixture(consumerCount);
    try {
      buildFullIndex({ projectRoot: root });

      // Small limit: the DISPLAYED caller list is capped, but the analyzer must
      // still see the full blast radius for truncation + risk.
      const small = analyzeGraphImpact(
        { kind: 'symbol', symbolId: 'alpha' },
        { projectRoot: root, limit: 3 },
      );
      expect(small.affectedCallerFiles.length).toBe(3);
      expect(small.truncations.callers).toBe(consumerCount - 3);
      // Risk reflects the UNCAPPED count (12), not the capped list length (3).
      expect(small.riskReasons.some((r) => r.includes(`${consumerCount} caller files`))).toBe(true);
      expect(small.riskReasons.some((r) => r.includes('3 caller files'))).toBe(false);

      // Large limit: nothing capped, no callers truncation.
      const large = analyzeGraphImpact(
        { kind: 'symbol', symbolId: 'alpha' },
        { projectRoot: root, limit: 200 },
      );
      expect(large.affectedCallerFiles.length).toBe(consumerCount);
      expect(large.truncations.callers).toBeUndefined();
      expect(large.riskReasons.some((r) => r.includes(`${consumerCount} caller files`))).toBe(true);

      // The displayed lists differ between runs, but the caller-driven risk
      // signal is identical — risk no longer collapses to the display cap.
      expect(small.affectedCallerFiles.length).not.toBe(large.affectedCallerFiles.length);
      expect(small.risk).toBe(large.risk);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('missing code-graph emits a diagnostic, not a throw', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-impact-no-graph-'));
    try {
      const r = analyzeGraphImpact(
        { kind: 'files', files: ['anything.ts'] },
        { projectRoot: root },
      );
      expect(r.diagnostics.some((d) => d.includes('code-graph store missing'))).toBe(true);
      expect(r.risk).toBe('low');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
