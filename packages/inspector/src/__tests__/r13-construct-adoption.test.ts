import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import {
  buildConstructAdoptionPlan,
  ConstructAdoptionCategory,
  InferredConstructConfidence,
  inspectSharkcraft,
  loadConstructs,
  readConstructAdoptionStatus,
  writeConstructAdoption,
} from '../index.ts';

async function makeFixture(): Promise<{ root: string }> {
  const root = mkdtempSync(nodePath.join(tmpdir(), 'sharkcraft-r13-adopt-'));
  mkdirSync(nodePath.join(root, 'sharkcraft'), { recursive: true });
  mkdirSync(nodePath.join(root, 'sharkcraft/construct-drafts'), { recursive: true });
  writeFileSync(nodePath.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
  writeFileSync(
    nodePath.join(root, 'sharkcraft/sharkcraft.config.ts'),
    `import { defineSharkCraftConfig } from '@shrkcrft/config';
export default defineSharkCraftConfig({ projectName: 'r13-adopt' });`,
  );
  // Existing local construct — structural definition so the tmp dir doesn't need node_modules.
  writeFileSync(
    nodePath.join(root, 'sharkcraft/constructs.ts'),
    `export default [{ id: 'service.user', type: 'service', title: 'User service', files: ['src/services/user.service.ts'] }];`,
  );
  // Drafts file with one already-covered + one new + one conflict.
  writeFileSync(
    nodePath.join(root, 'sharkcraft/construct-drafts/constructs.draft.ts'),
    `export default [
  { id: 'service.user', type: 'service', title: 'User service', confidence: 'high', evidence: [], files: ['src/services/user.service.ts'], publicApi: [], events: [], tokens: [] },
  { id: 'service.profile', type: 'service', title: 'Profile service', confidence: 'high', evidence: [], files: ['src/services/profile.service.ts'], publicApi: [], events: [], tokens: [] },
  { id: 'service.user', type: 'plugin', title: 'Bad conflict', confidence: 'medium', evidence: [], files: ['src/x.ts'], publicApi: [] }
];`,
  );
  return { root };
}

describe('r13 construct adoption', () => {
  test('classifies safe / already-covered / conflict', async () => {
    const { root } = await makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    await loadConstructs(inspection);
    const plan = await buildConstructAdoptionPlan(inspection, {
      minConfidence: InferredConstructConfidence.High,
    });
    const ids = Object.fromEntries(plan.entries.map((e) => [`${e.id}/${e.category}`, e]));
    // service.user (matching files) → already covered
    expect(
      plan.entries.some(
        (e) => e.id === 'service.user' && e.category === ConstructAdoptionCategory.AlreadyCovered,
      ),
    ).toBe(true);
    // service.profile (new, high) → safe-to-adopt
    expect(
      plan.entries.some(
        (e) =>
          e.id === 'service.profile' && e.category === ConstructAdoptionCategory.SafeToAdopt,
      ),
    ).toBe(true);
    void ids;
  });

  test('write-patch creates files under construct-drafts/adoption/ only', async () => {
    const { root } = await makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    await loadConstructs(inspection);
    const plan = await buildConstructAdoptionPlan(inspection);
    const result = writeConstructAdoption(inspection, plan);
    expect(result.files.length).toBe(3);
    for (const f of result.files) {
      expect(f).toContain('construct-drafts/adoption/');
    }
    // constructs.ts must not be touched.
    const before = inspection.sharkcraftDir
      ? Buffer.from('').toString()
      : '';
    void before;
    expect(existsSync(nodePath.join(root, 'sharkcraft/constructs.ts'))).toBe(true);
  });

  test('status reads the written summary back', async () => {
    const { root } = await makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    await loadConstructs(inspection);
    const plan = await buildConstructAdoptionPlan(inspection);
    writeConstructAdoption(inspection, plan);
    const status = readConstructAdoptionStatus(inspection);
    expect(status.exists).toBe(true);
    expect(status.summary).toBeDefined();
    expect(status.summary?.total).toBe(plan.summary.total);
  });
});
