/**
 * Preflight grounding: gate commands are overridable (so the CLI can ground
 * them in config.verificationCommands), and source-change classification is
 * monorepo-aware (nx / apps+libs), not only SharkCraft's own packages layout.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planChangedPreflight, PreflightProfile, PreflightAction } from '../changed-preflight.ts';

function gate(plan: ReturnType<typeof planChangedPreflight>, id: string) {
  return plan.gates.find((g) => g.id === id);
}

describe('planChangedPreflight grounding', () => {
  test('test/typecheck gate commands are overridable; defaults preserved otherwise', () => {
    const overridden = planChangedPreflight({
      projectRoot: '/tmp/does-not-exist',
      changedFiles: ['packages/x/src/a.ts'],
      profile: PreflightProfile.Strict,
      testCommand: 'pnpm -w test',
      typecheckCommand: 'pnpm -w typecheck',
    });
    expect(gate(overridden, 'tests')?.command).toBe('pnpm -w test');
    expect(gate(overridden, 'typecheck')?.command).toBe('pnpm -w typecheck');

    const defaulted = planChangedPreflight({
      projectRoot: '/tmp/does-not-exist',
      changedFiles: ['packages/x/src/a.ts'],
      profile: PreflightProfile.Strict,
    });
    expect(gate(defaulted, 'tests')?.command).toBe('bun test');
    expect(gate(defaulted, 'typecheck')?.command).toBe('bun x tsc -p tsconfig.base.json --noEmit');
  });

  test('apps/*/src counts as engine source on a monorepo (nx.json present)', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-preflight-nx-'));
    try {
      writeFileSync(join(root, 'nx.json'), '{}');
      const plan = planChangedPreflight({
        projectRoot: root,
        changedFiles: ['apps/api/src/foo.ts'],
        profile: PreflightProfile.Standard,
      });
      expect(gate(plan, 'typecheck')?.action).toBe(PreflightAction.Run);
      expect(gate(plan, 'boundaries')?.action).toBe(PreflightAction.Run);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('apps/*/src does NOT count as engine source without a monorepo signal', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-preflight-plain-'));
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'plain' }));
      const plan = planChangedPreflight({
        projectRoot: root,
        changedFiles: ['apps/api/src/foo.ts'],
        profile: PreflightProfile.Standard,
      });
      expect(gate(plan, 'typecheck')?.action).toBe(PreflightAction.Skip);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('caller-supplied sourceGlobs extend engine-source detection', () => {
    const plan = planChangedPreflight({
      projectRoot: '/tmp/does-not-exist',
      changedFiles: ['weird-root/thing.ts'],
      profile: PreflightProfile.Standard,
      sourceGlobs: ['weird-root/'],
    });
    expect(gate(plan, 'typecheck')?.action).toBe(PreflightAction.Run);
  });
});
