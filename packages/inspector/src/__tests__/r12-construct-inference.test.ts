import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import {
  InferredConstructConfidence,
  inferConstructs,
  inspectSharkcraft,
  loadConstructs,
  renderConstructDraftsModule,
} from '../index.ts';

function makeFixture(): string {
  const root = mkdtempSync(nodePath.join(tmpdir(), 'sharkcraft-r12-infer-'));
  mkdirSync(nodePath.join(root, 'src/services'), { recursive: true });
  mkdirSync(nodePath.join(root, 'src/plugins/widgets'), { recursive: true });
  writeFileSync(nodePath.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
  writeFileSync(
    nodePath.join(root, 'src/services/user.service.ts'),
    `export class UserService {}\nexport const USER_TOKEN = 'user.token';\n`,
  );
  writeFileSync(
    nodePath.join(root, 'src/services/user.service.spec.ts'),
    `import { UserService } from './user.service';\ndescribe('x', () => {});\n`,
  );
  writeFileSync(
    nodePath.join(root, 'src/services/index.ts'),
    `export * from './user.service';\n`,
  );
  writeFileSync(
    nodePath.join(root, 'src/plugins/widgets/index.ts'),
    `export const PLUGIN_REGISTRY = 'plugin.registry';\n`,
  );
  writeFileSync(
    nodePath.join(root, 'src/plugins/widgets/handlers.ts'),
    `import './index';\nexport const handlers = [];\n`,
  );
  return root;
}

describe('r12 construct inference', () => {
  test('infers a service from src/services/user.service.ts', async () => {
    const root = makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    await loadConstructs(inspection);
    const result = await inferConstructs(inspection);
    const service = result.candidates.find((c) => c.type === 'service' && c.files.some((f) => f.endsWith('user.service.ts')));
    expect(service).toBeDefined();
    expect(service?.confidence).toBe(InferredConstructConfidence.High);
    expect(service?.draft).toContain('defineConstruct({');
  });

  test('infers plugin-like construct from grouped plugin files', async () => {
    const root = makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    await loadConstructs(inspection);
    const result = await inferConstructs(inspection);
    const plugin = result.candidates.find((c) => c.type === 'plugin');
    expect(plugin).toBeDefined();
  });

  test('drafts module is valid-looking self-contained module text', async () => {
    const root = makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const result = await inferConstructs(inspection);
    const code = renderConstructDraftsModule(result);
    // Generated drafts must be self-contained — no @shrkcrft/* imports
    // (those packages aren't available in fresh downstream repos until
    // they're published / installed).
    expect(code).not.toMatch(/from ['"]@shrkcrft\//);
    expect(code).not.toMatch(/from ['"]@sharkcraft\//);
    expect(code).toContain('function defineConstruct');
    expect(code).toContain('export default [');
  });
});
