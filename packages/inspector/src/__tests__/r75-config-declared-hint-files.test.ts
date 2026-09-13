import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SharkCraftConfigSchema } from '@shrkcrft/config';
import { inspectSharkcraft } from '../sharkcraft-inspector.ts';
import { explainTaskRouting } from '../task-routing-hint-registry.ts';
import { loadPlaybooks, recommendPlaybooks } from '../playbook-registry.ts';

/**
 * `taskRoutingHintFiles` / `playbookFiles` are documented extension points the
 * loaders always read — but the STRICT config schema used to reject both keys,
 * which dropped the WHOLE config (every other plane with it) while the loaders
 * read them through a cast of a type that did not declare them. Here the keys
 * are declared, so a real project using them loads, and the extra files reach
 * the routing-hint and playbook recommenders.
 */

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'sc-r75-hintfiles-'));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'r75-hintfiles', version: '0.0.0', private: true }));
  const sc = join(root, 'sharkcraft');
  mkdirSync(join(sc, 'hints'), { recursive: true });
  mkdirSync(join(sc, 'pb'), { recursive: true });
  writeFileSync(
    join(sc, 'sharkcraft.config.ts'),
    `export default {
  projectName: 'r75-hintfiles',
  taskRoutingHintFiles: ['hints/extra.ts'],
  playbookFiles: ['pb/extra.ts'],
};
`,
  );
  // Plain object literals: the temp project has no node_modules to import from.
  writeFileSync(
    join(sc, 'hints', 'extra.ts'),
    `export default [
  {
    id: 'extra-hint',
    title: 'Extra routing hint',
    match: { keywords: ['zebra'] },
    recommends: { commands: ['shrk doctor'] },
  },
];
`,
  );
  writeFileSync(
    join(sc, 'pb', 'extra.ts'),
    `export default [
  {
    id: 'extra-pb',
    title: 'Extra playbook',
    tags: ['zebra'],
    steps: [{ id: 'one', title: 'Step one', commands: ['shrk doctor'] }],
  },
];
`,
  );
  return root;
}

describe('config-declared routing-hint and playbook files', () => {
  test('the strict schema accepts both keys', () => {
    const parsed = SharkCraftConfigSchema.safeParse({
      taskRoutingHintFiles: ['hints/extra.ts'],
      playbookFiles: ['pb/extra.ts'],
    });
    expect(parsed.success).toBe(true);
  });

  test('a project declaring them loads its config — nothing is silently dropped', async () => {
    const inspection = await inspectSharkcraft({ cwd: makeProject() });
    expect(inspection.configLoadError).toBeUndefined();
    expect(inspection.config).not.toBeNull();
    expect(inspection.config?.projectName).toBe('r75-hintfiles');
    expect(inspection.config?.taskRoutingHintFiles).toEqual(['hints/extra.ts']);
    expect(inspection.config?.playbookFiles).toEqual(['pb/extra.ts']);
  }, 30_000);

  test('the config-declared hint file reaches explainTaskRouting', async () => {
    const inspection = await inspectSharkcraft({ cwd: makeProject() });
    const matches = await explainTaskRouting(inspection, 'zebra');
    expect(matches.map((m) => m.hint.id)).toContain('extra-hint');
  }, 30_000);

  test('the config-declared playbook file reaches recommendPlaybooks', async () => {
    const inspection = await inspectSharkcraft({ cwd: makeProject() });
    const playbooks = await loadPlaybooks(inspection);
    const recs = recommendPlaybooks(playbooks, 'zebra');
    expect(recs.map((r) => r.playbook.id)).toContain('extra-pb');
  }, 30_000);
});
