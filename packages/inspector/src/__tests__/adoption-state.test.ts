import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ADOPTION_STATE_SCHEMA,
  AdoptionCategory,
  AdoptionFreshnessStatus,
  AdoptionKind,
  archivePreviousAdoptionOutputs,
  buildAdoptionState,
  computeAdoptionFreshness,
  readAdoptionState,
  writeAdoptionState,
} from '../index.ts';
import type { IAdoptionPlan } from '../onboarding-adoption.ts';

function makePlan(overrides: Partial<IAdoptionPlan> = {}): IAdoptionPlan {
  const safeItems = [
    {
      kind: AdoptionKind.Rule,
      id: 'rule.foo',
      title: 'Foo rule',
      category: AdoptionCategory.SafeToAdopt,
      reason: 'inferred',
      draftFile: 'inferred-rules.draft.ts',
      preview: 'Foo rule',
    },
  ];
  return {
    confidence: 'high',
    included: [AdoptionKind.Rule],
    excluded: [],
    items: safeItems,
    summary: {
      [AdoptionCategory.SafeToAdopt]: 1,
      [AdoptionCategory.ManualReview]: 0,
      [AdoptionCategory.LowConfidence]: 0,
      [AdoptionCategory.Conflict]: 0,
      [AdoptionCategory.AlreadyCovered]: 0,
      [AdoptionCategory.Skipped]: 0,
    },
    byCategory: {
      [AdoptionCategory.SafeToAdopt]: safeItems,
      [AdoptionCategory.ManualReview]: [],
      [AdoptionCategory.LowConfidence]: [],
      [AdoptionCategory.Conflict]: [],
      [AdoptionCategory.AlreadyCovered]: [],
      [AdoptionCategory.Skipped]: [],
    },
    ...overrides,
  };
}

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-adoption-state-'));
  mkdirSync(join(root, 'sharkcraft', 'onboarding', 'adoption'), { recursive: true });
  writeFileSync(join(root, 'sharkcraft', 'onboarding', 'inferred-rules.draft.ts'), 'export const x = 1;\n');
  // A real target file we hash.
  writeFileSync(join(root, 'sharkcraft', 'rules.ts'), '// rules\nexport default [];\n');
  return root;
}

describe('adoption state', () => {
  test('build → write → read roundtrip', () => {
    const root = makeFixture();
    const state = buildAdoptionState({
      projectRoot: root,
      command: 'shrk onboard adopt --write-patch',
      patchPath: join(root, 'sharkcraft/onboarding/adoption/adopt.patch'),
      summaryPath: join(root, 'sharkcraft/onboarding/adoption/adopt-summary.json'),
      diffFormat: 'unified',
      plan: makePlan(),
      targets: [{ relativePath: 'sharkcraft/rules.ts', existed: true, beforeHash: '00', bytesAdded: 0 }],
      generatedFiles: [join(root, 'sharkcraft/onboarding/adoption/adopt.patch')],
    });
    expect(state.schema).toBe(ADOPTION_STATE_SCHEMA);
    const path = writeAdoptionState(root, state);
    expect(existsSync(path)).toBe(true);
    const round = readAdoptionState(root);
    expect(round?.schema).toBe(ADOPTION_STATE_SCHEMA);
    expect(round?.diffFormat).toBe('unified');
  });

  test('freshness is fresh right after creation', () => {
    const root = makeFixture();
    const plan = makePlan();
    const ruleHash = createHash('sha256')
      .update(readFileSync(join(root, 'sharkcraft/rules.ts'), 'utf8'))
      .digest('hex');
    const state = buildAdoptionState({
      projectRoot: root,
      command: 'shrk onboard adopt --write-patch',
      patchPath: 'p',
      summaryPath: 's',
      diffFormat: 'unified',
      plan,
      targets: [{ relativePath: 'sharkcraft/rules.ts', existed: true, beforeHash: ruleHash, bytesAdded: 0 }],
      generatedFiles: [],
    });
    writeAdoptionState(root, state);
    const fr = computeAdoptionFreshness(root, state);
    expect(fr.status).toBe(AdoptionFreshnessStatus.Fresh);
  });

  test('freshness becomes stale when a target file changes', () => {
    const root = makeFixture();
    const ruleHash = createHash('sha256')
      .update(readFileSync(join(root, 'sharkcraft/rules.ts'), 'utf8'))
      .digest('hex');
    const state = buildAdoptionState({
      projectRoot: root,
      command: 'shrk onboard adopt --write-patch',
      patchPath: 'p',
      summaryPath: 's',
      diffFormat: 'unified',
      plan: makePlan(),
      targets: [{ relativePath: 'sharkcraft/rules.ts', existed: true, beforeHash: ruleHash, bytesAdded: 0 }],
      generatedFiles: [],
    });
    writeAdoptionState(root, state);
    writeFileSync(join(root, 'sharkcraft/rules.ts'), '// edited\nexport default [1];\n');
    const fr = computeAdoptionFreshness(root, state);
    expect(fr.status).toBe(AdoptionFreshnessStatus.Stale);
    expect(fr.staleReasons.some((r) => r.includes('rules.ts'))).toBe(true);
  });

  test('freshness stale when a draft file changes', () => {
    const root = makeFixture();
    const state = buildAdoptionState({
      projectRoot: root,
      command: 'shrk onboard adopt --write-patch',
      patchPath: 'p',
      summaryPath: 's',
      diffFormat: 'unified',
      plan: makePlan(),
      targets: [],
      generatedFiles: [],
    });
    writeAdoptionState(root, state);
    // Change the draft contents.
    writeFileSync(join(root, 'sharkcraft/onboarding/inferred-rules.draft.ts'), 'export const x = 2;\n');
    const fr = computeAdoptionFreshness(root, state);
    expect(fr.status).toBe(AdoptionFreshnessStatus.Stale);
    expect(fr.changedDrafts.length).toBeGreaterThan(0);
  });

  test('archive moves outputs into history/ and never overwrites', () => {
    const root = makeFixture();
    writeFileSync(join(root, 'sharkcraft/onboarding/adoption/adopt.patch'), 'old patch');
    writeFileSync(join(root, 'sharkcraft/onboarding/adoption/adoption-state.json'), '{"schema":"sharkcraft.adoption-state/v1"}');
    const first = archivePreviousAdoptionOutputs(root, '2026-01-01T00-00-00-000Z');
    expect(first.archived.length).toBeGreaterThan(0);
    // Second archive with same timestamp should not overwrite the existing
    // history entries (they're identified by timestamp).
    writeFileSync(join(root, 'sharkcraft/onboarding/adoption/adopt.patch'), 'newer');
    writeFileSync(join(root, 'sharkcraft/onboarding/adoption/adoption-state.json'), '{"schema":"sharkcraft.adoption-state/v1"}');
    const second = archivePreviousAdoptionOutputs(root, '2026-01-01T00-00-00-000Z');
    // Both archived 0 (target name collided with first run).
    expect(second.archived.length).toBe(0);
  });

  test('missing state file produces unknown freshness', () => {
    const root = makeFixture();
    const fr = computeAdoptionFreshness(root, null);
    expect(fr.status).toBe(AdoptionFreshnessStatus.Unknown);
  });
});
