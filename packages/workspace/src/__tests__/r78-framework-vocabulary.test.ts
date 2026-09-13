/**
 * r78 — round 15 (15.1): the framework vocabulary is ONE constant, and the
 * profile detector reads marker files.
 *
 *   - `FrameworkId` is THE list `detectFrameworks` reports (a convention's
 *     `appliesTo.frameworks` names it). It was a module-private table, and the
 *     profile detector tested `'next'` against a detector that only emits
 *     `'nextjs'` — a branch that could never fire.
 *   - `has-turborepo` tested `turbo.json` / `.turbo` against `topLevelDirs`,
 *     which lists directories only and drops `.turbo`: only a `turbo`
 *     dependency could ever detect it. Once `profileIds` scopes conventions,
 *     that made a has-turborepo convention wrongly not-applicable in a
 *     Turborepo without the dependency.
 *
 * Real workspaces on disk, through `inspectWorkspace`.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectFrameworks, isFrameworkId, listFrameworkIds } from '../framework-detector.ts';
import { FrameworkId } from '../framework-id.ts';
import { detectProfiles, WorkspaceProfile } from '../profile-detector.ts';
import { inspectWorkspace } from '../workspace-inspector.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function workspace(files: Record<string, string>, dirs: readonly string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r78-ws-'));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(root, rel), body);
  for (const d of dirs) mkdirSync(join(root, d), { recursive: true });
  return root;
}

describe('FrameworkId is THE framework vocabulary', () => {
  test('listFrameworkIds ≡ the enum, and the detector reports only its members', () => {
    expect([...listFrameworkIds()].sort()).toEqual([...Object.values(FrameworkId)].sort());
    // Every framework's package present → every id detected, each a vocabulary member.
    const deps: Record<string, string> = {};
    for (const p of ['@angular/core', 'react', 'vue', 'svelte', 'next', 'nuxt', '@nestjs/core', 'express', 'fastify', 'nx', 'aws-lambda', 'electron', 'typescript', '@types/bun']) {
      deps[p] = '*';
    }
    const detected = detectFrameworks(workspace({}), { name: 'x', version: '0.0.0', dependencies: deps });
    expect(detected.map((f) => f.id).sort()).toEqual([...listFrameworkIds()].sort());
    expect(detected.every((f) => isFrameworkId(f.id))).toBe(true);
    expect(isFrameworkId('next')).toBe(false);
    expect(isFrameworkId('nextjs')).toBe(true);
  });

  test("the detector's `nextjs` reaches has-next through the framework branch alone (it tested 'next')", () => {
    const r = detectProfiles({
      packageJson: null,
      frameworks: [{ id: FrameworkId.NextJs, name: 'Next.js', evidence: ['depends on next'] }],
      topLevelDirs: [],
      hasTsConfig: false,
    });
    expect(r.profiles).toContain(WorkspaceProfile.HasNext);
  });

  test('the profile detector passes no string literal to hasFramework (a vocabulary member only)', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'profile-detector.ts'), 'utf8');
    expect(src.match(/hasFramework\(frameworks, '/g) ?? []).toEqual([]);
    expect((src.match(/hasFramework\(frameworks, FrameworkId\.\w+\)/g) ?? []).length).toBeGreaterThan(0);
  });
});

describe('has-turborepo reads its marker files', () => {
  test('a root turbo.json, no turbo dependency → detected, with the marker as evidence', async () => {
    const root = workspace({ 'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }), 'turbo.json': '{}' });
    const ws = await inspectWorkspace({ startDir: root });
    expect(ws.profiles).toContain(WorkspaceProfile.HasTurborepo);
    expect(ws.profileEvidence.find((e) => e.profile === WorkspaceProfile.HasTurborepo)?.reason).toContain('turbo.json');
  });

  test('a .turbo cache directory (an ignored dir) → detected', async () => {
    const root = workspace({ 'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }) }, ['.turbo']);
    const ws = await inspectWorkspace({ startDir: root });
    expect(ws.profiles).toContain(WorkspaceProfile.HasTurborepo);
    // `.turbo` stays out of the layout listing — only the marker probe sees it.
    expect(ws.topLevelDirs).not.toContain('.turbo');
  });

  test('neither marker nor dependency → not detected', async () => {
    const root = workspace({ 'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }) });
    expect((await inspectWorkspace({ startDir: root })).profiles).not.toContain(WorkspaceProfile.HasTurborepo);
  });
});
