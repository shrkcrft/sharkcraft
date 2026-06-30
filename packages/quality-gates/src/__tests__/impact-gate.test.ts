import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFullIndex } from '@shrkcrft/graph';
import { impactGate } from '../index.ts';

/** Write a workspace package whose `index.ts` carries `indexBody`. */
function writePackage(root: string, name: string, indexBody: string): void {
  mkdirSync(join(root, 'packages', name, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'packages', name, 'package.json'),
    JSON.stringify({ name: `@demo/${name}`, main: 'src/index.ts' }, null, 2),
  );
  writeFileSync(join(root, 'packages', name, 'src', 'index.ts'), indexBody);
}

/**
 * A `core` package imported by `midCount` mid packages; each mid has
 * `extrasPerMid` extra files importing the mid's own index (transitive
 * dependents of `core`). Tuned to land on a target risk:
 *   - (5 mids, 0 extras) → `high`     (5 direct + 6 pkgs + public API)
 *   - (5 mids, 2 extras) → `critical` (… + 10 transitive dependents)
 * The graph is built but NO git repo is created — callers analyze the
 * `core` index via the explicit `files` path.
 */
function hubFixture(midCount: number, extrasPerMid: number): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-impact-gate-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo-root', workspaces: ['packages/*'] }, null, 2),
  );
  writePackage(root, 'core', 'export function core() { return 1; }');
  for (let i = 0; i < midCount; i += 1) {
    writePackage(root, `m${i}`, `import { core } from '@demo/core';\nexport const f${i} = core();`);
    for (let e = 0; e < extrasPerMid; e += 1) {
      writeFileSync(
        join(root, 'packages', `m${i}`, 'src', `e${e}.ts`),
        `import { f${i} } from './index.ts';\nexport const x${e} = f${i};`,
      );
    }
  }
  buildFullIndex({ projectRoot: root });
  return root;
}

/** A lone, non-exported file with no dependents → `low` risk. */
function lowFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-impact-gate-low-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo-root', workspaces: ['packages/*'] }, null, 2),
  );
  mkdirSync(join(root, 'packages', 'solo', 'src'), { recursive: true });
  writeFileSync(
    join(root, 'packages', 'solo', 'package.json'),
    JSON.stringify({ name: '@demo/solo', main: 'src/index.ts' }, null, 2),
  );
  writeFileSync(join(root, 'packages', 'solo', 'src', 'util.ts'), 'const x = 1;\n');
  writeFileSync(join(root, 'packages', 'solo', 'src', 'index.ts'), 'export const solo = 1;\n');
  buildFullIndex({ projectRoot: root });
  return root;
}

describe('impactGate', () => {
  let root = '';
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  test('no graph index → skipped + `shrk graph index` hint', () => {
    root = mkdtempSync(join(tmpdir(), 'shrk-impact-gate-nograph-'));
    const r = impactGate(root);
    expect(r.status).toBe('skipped');
    expect(r.message).toContain('graph index missing');
    expect(r.nextCommands).toContain('shrk graph index');
  });

  test('graph present but no diff vs sinceRef → skipped (No files changed)', () => {
    root = mkdtempSync(join(tmpdir(), 'shrk-impact-gate-git-'));
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'demo-root', workspaces: ['packages/*'] }, null, 2),
    );
    writePackage(root, 'core', 'export function core() { return 1; }');
    // Commit the sources on `main` FIRST so there is no tracked diff; the graph
    // store written next is untracked and never shows up in `git diff`.
    const opts = { cwd: root, encoding: 'utf8' as const };
    spawnSync('git', ['init', '-q', '-b', 'main'], opts);
    spawnSync('git', ['config', 'user.email', 'test@example.com'], opts);
    spawnSync('git', ['config', 'user.name', 'test'], opts);
    spawnSync('git', ['add', '-A'], opts);
    spawnSync('git', ['commit', '-q', '-m', 'init'], opts);
    buildFullIndex({ projectRoot: root });

    const r = impactGate(root, { sinceRef: 'main' });
    expect(r.status).toBe('skipped');
    expect(r.message).toContain('No files changed');
    expect(r.label).toBe('Impact (since main)');
  });

  test('files path analyzes the given changed file (not the gitref) ', () => {
    root = hubFixture(5, 0); // no git repo → a gitref diff would yield nothing
    const r = impactGate(root, { files: ['packages/core/src/index.ts'] });
    // It actually analyzed `core` (real dependents), proving it didn't fall
    // back to diffing `main` (which would skip with no git repo present).
    expect(r.status).not.toBe('skipped');
    expect(r.label).toBe('Impact (changed files)');
    expect((r.details as { direct?: number } | undefined)?.direct).toBeGreaterThan(0);
  });

  test('risk level inside failOn → fail (high with --fail-on high)', () => {
    root = hubFixture(5, 0); // → high
    const r = impactGate(root, { files: ['packages/core/src/index.ts'], failOn: ['high'] });
    expect((r.details as { risk?: string } | undefined)?.risk).toBe('high');
    expect(r.status).toBe('fail');
  });

  test('threshold: --fail-on high also fails a CRITICAL change', () => {
    root = hubFixture(5, 2); // → critical
    const r = impactGate(root, { files: ['packages/core/src/index.ts'], failOn: ['high'] });
    expect((r.details as { risk?: string } | undefined)?.risk).toBe('critical');
    // critical is not literally in {high}, but rank(critical) >= rank(high).
    expect(r.status).toBe('fail');
  });

  test('high risk not in failOn (default critical) → warn', () => {
    root = hubFixture(5, 0); // → high
    const r = impactGate(root, { files: ['packages/core/src/index.ts'] });
    expect((r.details as { risk?: string } | undefined)?.risk).toBe('high');
    expect(r.status).toBe('warn');
  });

  test('low risk → pass', () => {
    root = lowFixture();
    const r = impactGate(root, { files: ['packages/solo/src/util.ts'] });
    expect((r.details as { risk?: string } | undefined)?.risk).toBe('low');
    expect(r.status).toBe('pass');
  });
});
