/**
 * Round-3 onboarding/inference correctness fixes.
 *
 *   O3-1  inferRules must NOT emit the imperative "strict mode is OFF" rule
 *         when the tsconfig inherits strict via a relative `extends`.
 *   O3-2  monorepo discovery is driven by the declared `workspaces` globs, so
 *         non-standard (modules) and grouped (two-level) layouts resolve to
 *         the real package directories rather than the grouping dirs.
 *   O3-3  monorepo boundary candidates flow into plan.inferredBoundaryRules.
 *   O3-4  `onboard --dry-run --write-drafts` writes NO files.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildOnboardingPlan } from '../onboarding.ts';
import { inspectSharkcraft } from '../sharkcraft-inspector.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts');

function tmpRoot(tag: string): string {
  return mkdtempSync(join(tmpdir(), `shrk-onb3-${tag}-`));
}

function writeJson(file: string, body: unknown): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify(body, null, 2));
}

// ─── O3-1 ─────────────────────────────────────────────────────────────────

describe('O3-1 inferRules strict via extends', () => {
  test('does NOT emit a "strict OFF" rule when strict is inherited from a base', async () => {
    const root = tmpRoot('strict');
    try {
      writeJson(join(root, 'package.json'), { name: 'strict-fixture', version: '0.0.0' });
      writeJson(join(root, 'tsconfig.base.json'), { compilerOptions: { strict: true } });
      writeJson(join(root, 'tsconfig.json'), {
        extends: './tsconfig.base.json',
        compilerOptions: {},
      });
      const inspection = await inspectSharkcraft({ cwd: root });
      const plan = buildOnboardingPlan(inspection);
      const strictRule = plan.inferredRules.find((r) => r.id === 'typescript.strict-mode');
      expect(strictRule).toBeDefined();
      expect(strictRule?.title).toBe('TypeScript strict mode enabled');
      // No imperative "turn it on" content anywhere, and no unconfirmed advisory.
      expect(plan.inferredRules.some((r) => /strict mode is OFF/i.test(r.content))).toBe(false);
      expect(
        plan.inferredRules.some((r) => r.id === 'typescript.strict-mode-unconfirmed'),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('emits an advisory (not high-confidence) when strict cannot be resolved', async () => {
    const root = tmpRoot('strict-unknown');
    try {
      writeJson(join(root, 'package.json'), { name: 'unknown-fixture', version: '0.0.0' });
      writeJson(join(root, 'tsconfig.json'), {
        extends: '@tsconfig/strictest',
        compilerOptions: {},
      });
      const inspection = await inspectSharkcraft({ cwd: root });
      const plan = buildOnboardingPlan(inspection);
      // No confirmed-off rule; instead the unconfirmed advisory (low priority).
      expect(plan.inferredRules.some((r) => /strict mode is OFF/i.test(r.content))).toBe(false);
      const advisory = plan.inferredRules.find(
        (r) => r.id === 'typescript.strict-mode-unconfirmed',
      );
      expect(advisory).toBeDefined();
      expect(advisory?.priority).toBe('low');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── O3-2 ─────────────────────────────────────────────────────────────────

describe('O3-2 workspace-driven monorepo discovery', () => {
  test('modules/* layout discovers the two packages', async () => {
    const root = tmpRoot('modules');
    try {
      writeJson(join(root, 'package.json'), {
        name: 'modules-fixture',
        version: '0.0.0',
        private: true,
        workspaces: ['modules/*'],
      });
      writeJson(join(root, 'modules', 'a', 'package.json'), { name: 'mod-a' });
      writeJson(join(root, 'modules', 'b', 'package.json'), { name: 'mod-b' });
      const inspection = await inspectSharkcraft({ cwd: root });
      const plan = buildOnboardingPlan(inspection);
      expect(plan.monorepoSummary).not.toBeNull();
      const m = plan.monorepoSummary!;
      // Leading segment is not apps/libs → classified as packages.
      expect(m.packages.length).toBe(2);
      const paths = m.packages.map((p) => p.path).sort();
      expect(paths).toEqual(['modules/a', 'modules/b']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('packages/*/* layout discovers the leaf packages, not the grouping dirs', async () => {
    const root = tmpRoot('grouped');
    try {
      writeJson(join(root, 'package.json'), {
        name: 'grouped-fixture',
        version: '0.0.0',
        private: true,
        workspaces: ['packages/*/*'],
      });
      writeJson(join(root, 'packages', 'group1', 'pkgA', 'package.json'), { name: 'pkg-a' });
      writeJson(join(root, 'packages', 'group1', 'pkgB', 'package.json'), { name: 'pkg-b' });
      writeJson(join(root, 'packages', 'group2', 'pkgC', 'package.json'), { name: 'pkg-c' });
      const inspection = await inspectSharkcraft({ cwd: root });
      const plan = buildOnboardingPlan(inspection);
      const m = plan.monorepoSummary!;
      const paths = m.packages.map((p) => p.path).sort();
      expect(paths).toEqual([
        'packages/group1/pkgA',
        'packages/group1/pkgB',
        'packages/group2/pkgC',
      ]);
      // The grouping directories themselves are NOT reported as packages.
      expect(paths).not.toContain('packages/group1');
      expect(paths).not.toContain('packages/group2');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── O3-3 ─────────────────────────────────────────────────────────────────

describe('O3-3 monorepo boundary candidates reach inferredBoundaryRules', () => {
  test('apps + packages layout yields the no-imports-from-apps boundary rule', async () => {
    const root = tmpRoot('boundary');
    try {
      writeJson(join(root, 'package.json'), {
        name: 'boundary-fixture',
        version: '0.0.0',
        private: true,
        workspaces: ['apps/*', 'packages/*'],
      });
      writeJson(join(root, 'apps', 'web', 'package.json'), { name: 'app-web' });
      writeJson(join(root, 'packages', 'core', 'package.json'), { name: 'pkg-core' });
      const inspection = await inspectSharkcraft({ cwd: root });
      const plan = buildOnboardingPlan(inspection);
      expect(plan.inferredBoundaryRules.length).toBeGreaterThan(0);
      const rule = plan.inferredBoundaryRules.find(
        (b) => b.id === 'architecture.packages.no-imports-from-apps',
      );
      expect(rule).toBeDefined();
      expect(rule?.severity).toBe('warning');
      expect(rule?.from).toEqual(['packages/**']);
      expect(rule?.forbiddenImports).toEqual(['apps/**']);
      expect(rule?.suggestedFix.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── O3-4 ─────────────────────────────────────────────────────────────────

describe('O3-4 onboard --dry-run is authoritative', () => {
  test('--dry-run --write-drafts writes NO files', () => {
    const root = tmpRoot('dryrun');
    try {
      writeJson(join(root, 'package.json'), {
        name: 'dryrun-fixture',
        version: '0.0.0',
        scripts: { test: 'bun test' },
      });
      const res = spawnSync(
        'bun',
        ['run', CLI_MAIN, 'onboard', '--cwd', root, '--dry-run', '--write-drafts'],
        { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 90_000 },
      );
      // The note (about --dry-run overriding --write-drafts) goes to stderr.
      expect(res.stderr ?? '').toContain('--dry-run overrode --write-drafts');
      // Crucially: nothing was written under sharkcraft/.
      expect(existsSync(join(root, 'sharkcraft'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('--write-drafts (no --dry-run) DOES write drafts (positive control)', () => {
    const root = tmpRoot('write');
    try {
      writeJson(join(root, 'package.json'), {
        name: 'write-fixture',
        version: '0.0.0',
        scripts: { test: 'bun test' },
      });
      spawnSync('bun', ['run', CLI_MAIN, 'onboard', '--cwd', root, '--write-drafts'], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        timeout: 90_000,
      });
      expect(existsSync(join(root, 'sharkcraft', 'onboarding'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
