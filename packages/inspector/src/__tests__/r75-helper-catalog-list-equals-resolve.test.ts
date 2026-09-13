/**
 * Round 11 §3.6 — one helper catalog. `helper list|get|plan` read only the
 * built-in (empty) set while the resolver read the pack loader: the self-config
 * doctor saw a helper `helper get` called unknown. The resolver's `helper` ids
 * now derive from `listAllHelpers`, so list ≡ resolve by construction (the r73
 * invariant, held here for the helper kind on real registries).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  buildPackHelperPlan,
  inspectSharkcraft,
  listAllHelpers,
  referenceIdsFor,
  warmReferenceRegistries,
} from '../index.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function write(root: string, rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

const PACK_HELPER = `export default [{
  id: 'r75.add-route',
  title: 'Add route',
  description: 'Register a route',
  variables: [{ name: 'name', required: true, description: 'route name' }],
  operations: [
    { kind: 'append-line', targetPath: 'src/routes.ts', snippet: "export const {{name}} = '{{name}}';", description: 'register' },
    { kind: 'remove-line', targetPath: 'src/legacy.ts', find: '{{name}}-legacy', description: 'drop the legacy route' },
  ],
  manualChecklist: ['Restart the dev server for {{name}}'],
  safety: { outputKind: 'plan', requiresHumanReview: true },
}];\n`;
const LOCAL_HELPER = `export default [{ id: 'r75.local-helper', title: 'Local', description: 'local', variables: [], safety: { outputKind: 'checklist' }, manualChecklist: ['do it'] }];\n`;

function consumer(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-helpers-'));
  roots.push(root);
  write(root, 'package.json', JSON.stringify({ name: 'consumer', version: '0.0.0' }));
  write(root, 'sharkcraft/sharkcraft.config.ts', "export default { projectName: 'consumer' };\n");
  write(root, 'sharkcraft/helpers.ts', LOCAL_HELPER);
  const pack = join(root, 'node_modules', '@r75', 'helpers');
  write(pack, 'package.json', JSON.stringify({ name: '@r75/helpers', version: '0.0.1', sharkcraft: { manifest: './manifest.json' } }));
  write(
    pack,
    'manifest.json',
    JSON.stringify({
      schema: 'sharkcraft.pack/v1',
      info: { name: '@r75/helpers', version: '0.0.1' },
      contributions: { helperFiles: ['./helpers.ts'] },
    }),
  );
  write(pack, 'helpers.ts', PACK_HELPER);
  return root;
}

describe('the helper catalog', () => {
  test('referenceIdsFor(helper) ≡ listAllHelpers ids, and both see local AND pack helpers', async () => {
    const inspection = await inspectSharkcraft({ cwd: consumer() });
    await warmReferenceRegistries(inspection);
    const catalog = await listAllHelpers(inspection);
    const listed = catalog.entries.map((h) => h.id).sort();
    expect([...referenceIdsFor(inspection, 'helper')].sort()).toEqual(listed);
    expect(listed).toEqual(['r75.add-route', 'r75.local-helper']);
    expect(catalog.entries.find((h) => h.id === 'r75.add-route')).toMatchObject({
      source: 'pack',
      packageName: '@r75/helpers',
      // The pack-relative path exactly as the manifest declares it.
      sourceFile: './helpers.ts',
      requiresHumanReview: true,
    });
    expect(catalog.entries.find((h) => h.id === 'r75.local-helper')?.source).toBe('local');
    expect(catalog.files.map((f) => f.status)).toEqual(['loaded', 'loaded']);
  });

  test('a pack helper plans: declarative ops rendered, placeholders substituted, required vars enforced', async () => {
    const inspection = await inspectSharkcraft({ cwd: consumer() });
    const helper = (await listAllHelpers(inspection)).entries.find((h) => h.id === 'r75.add-route')!;
    const refused = buildPackHelperPlan(helper, {});
    expect(refused).toMatchObject({ ok: false, missing: ['name'] });
    const built = buildPackHelperPlan(helper, { name: 'users' });
    if (!built.ok) throw new Error(built.message);
    expect(built.plan.ops).toEqual([
      { kind: 'append', targetPath: 'src/routes.ts', snippet: "export const users = 'users';" },
      { kind: 'replace', targetPath: 'src/legacy.ts', fromPattern: 'users-legacy', snippet: '' },
    ]);
    expect(built.plan.manualSteps).toEqual([{ kind: 'checklist', description: 'Restart the dev server for users' }]);
    expect(built.plan.conflicts).toEqual([]);
    expect(built.plan.requiresHumanReview).toBe(true);
  });
});
