import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import {
  buildConstructAdoptionDiff,
  ConstructDiffBlockKind,
  inspectSharkcraft,
  loadConstructs,
  renderConstructAdoptionDiff,
} from '../index.ts';

async function makeFixture(): Promise<{ root: string }> {
  const root = mkdtempSync(nodePath.join(tmpdir(), 'sharkcraft-r14-construct-diff-'));
  mkdirSync(nodePath.join(root, 'sharkcraft'), { recursive: true });
  mkdirSync(nodePath.join(root, 'sharkcraft/construct-drafts'), { recursive: true });
  writeFileSync(nodePath.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
  writeFileSync(
    nodePath.join(root, 'sharkcraft/sharkcraft.config.ts'),
    `import { defineSharkCraftConfig } from '@shrkcrft/config';
export default defineSharkCraftConfig({ projectName: 'r14-construct-diff' });`,
  );
  writeFileSync(
    nodePath.join(root, 'sharkcraft/constructs.ts'),
    `export default [{ id: 'service.user', type: 'service', title: 'User service', files: ['src/services/user.service.ts'] }];`,
  );
  writeFileSync(
    nodePath.join(root, 'sharkcraft/construct-drafts/constructs.draft.ts'),
    `export default [
  { id: 'service.user', type: 'service', title: 'User service', confidence: 'high', evidence: [], files: ['src/services/user.service.ts','src/services/user.repository.ts'], publicApi: ['getUser'] },
  { id: 'service.profile', type: 'service', title: 'Profile service', confidence: 'high', evidence: [], files: ['src/services/profile.service.ts'], publicApi: ['getProfile'] },
  { id: 'service.user', type: 'plugin', title: 'Bad conflict', confidence: 'medium', evidence: [], files: ['src/x.ts'] }
];`,
  );
  return { root };
}

describe('r14 construct adoption diff', () => {
  test('emits new-construct, field-added, and conflict blocks', async () => {
    const { root } = await makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    await loadConstructs(inspection);
    const diff = await buildConstructAdoptionDiff(inspection);
    const kinds = diff.blocks.map((b) => b.kind);
    expect(kinds).toContain(ConstructDiffBlockKind.NewConstruct);
    expect(kinds).toContain(ConstructDiffBlockKind.FieldAdded);
    expect(kinds).toContain(ConstructDiffBlockKind.Conflict);
  });

  test('text render contains markers', async () => {
    const { root } = await makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    await loadConstructs(inspection);
    const diff = await buildConstructAdoptionDiff(inspection);
    const text = renderConstructAdoptionDiff(diff, 'text');
    expect(text).toContain('Construct adoption diff');
    expect(text).toMatch(/\+ /);
  });

  test('HTML output is JS-free', async () => {
    const { root } = await makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    await loadConstructs(inspection);
    const diff = await buildConstructAdoptionDiff(inspection);
    const html = renderConstructAdoptionDiff(diff, 'html');
    expect(html.includes('<script')).toBe(false);
    expect(html).toContain('Construct adoption diff');
  });

  test('json render parses with the right schema', async () => {
    const { root } = await makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    await loadConstructs(inspection);
    const diff = await buildConstructAdoptionDiff(inspection);
    const json = renderConstructAdoptionDiff(diff, 'json');
    const parsed = JSON.parse(json);
    expect(parsed.schema).toBe('sharkcraft.construct-adoption-diff/v1');
    expect(parsed.summary).toBeDefined();
  });
});
