import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import {
  buildOnboardAdoptionDiff,
  inspectSharkcraft,
  OnboardDiffBlockKind,
  renderOnboardAdoptionDiff,
} from '../index.ts';

function makeFixture(): { root: string } {
  const root = mkdtempSync(nodePath.join(tmpdir(), 'sharkcraft-r14-onboard-diff-'));
  mkdirSync(nodePath.join(root, 'src/services'), { recursive: true });
  writeFileSync(
    nodePath.join(root, 'package.json'),
    JSON.stringify({ name: 'r14-test', version: '0.0.0', scripts: { test: 'echo ok' } }),
  );
  writeFileSync(nodePath.join(root, 'tsconfig.json'), JSON.stringify({}));
  writeFileSync(
    nodePath.join(root, 'src/services/user.service.ts'),
    'export class UserService {}',
  );
  return { root };
}

describe('r14 onboard adoption diff', () => {
  test('reports target files that don\'t exist as new', async () => {
    const { root } = makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const diff = buildOnboardAdoptionDiff(inspection);
    expect(diff.schema).toBe('sharkcraft.onboard-adoption-diff/v1');
    // Most target files (rules.ts, paths.ts) don't exist → warnings should mention them.
    expect(diff.warnings.length).toBeGreaterThan(0);
  });

  test('text format renders without errors', async () => {
    const { root } = makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const diff = buildOnboardAdoptionDiff(inspection);
    const text = renderOnboardAdoptionDiff(diff, 'text');
    expect(text).toContain('Onboard adoption diff');
  });

  test('markdown format includes a Next steps section', async () => {
    const { root } = makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const diff = buildOnboardAdoptionDiff(inspection);
    const md = renderOnboardAdoptionDiff(diff, 'markdown');
    expect(md).toContain('## Next steps');
    expect(md).toMatch(/SharkCraft never modifies your live/);
  });

  test('HTML is JS-free and renders the summary', async () => {
    const { root } = makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const diff = buildOnboardAdoptionDiff(inspection);
    const html = renderOnboardAdoptionDiff(diff, 'html');
    expect(html.includes('<script')).toBe(false);
    expect(html).toContain('Onboard adoption diff');
  });

  test('json round-trips the diff structure', async () => {
    const { root } = makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const diff = buildOnboardAdoptionDiff(inspection);
    const parsed = JSON.parse(renderOnboardAdoptionDiff(diff, 'json'));
    expect(parsed.schema).toBe('sharkcraft.onboard-adoption-diff/v1');
    // Touch the enum so it's recognised in the import tree.
    void OnboardDiffBlockKind.NewBlock;
  });
});
