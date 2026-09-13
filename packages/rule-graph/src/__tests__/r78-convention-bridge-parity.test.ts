/**
 * r78 — round 15 (15.1): `conventions check` ≡ the rule-graph bridge.
 *
 * Two code paths answered "which files does this convention cover?" and
 * disagreed in both directions on the same file: check compiled `src/**\/*.ts`
 * so it missed `src/a.ts` (the bridge matched it), and the bridge dropped a
 * convention with no `fileGlobs` (check enforced it on every file), so
 * `rule-graph for <file>` omitted conventions check enforced there. Neither
 * read `profileIds` / `frameworks` / `languages`.
 *
 * Both now read `conventionScope` (THE applicability authority). The lock:
 * over the graph's own file list, for every convention, the bridge's
 * `applies-rule` edges ≡ the files `conventions check` hit (every rule here is
 * `forbidMatch: '.'`, one hit per covered file) ≡ `conventionScope(...).files`.
 * A real project, a real graph index, the real loaders.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildFullIndex, GraphStore, NodeKind } from '@shrkcrft/graph';
import { checkConventionsAgainstFiles, conventionScope, inspectSharkcraft, listConventions } from '@shrkcrft/inspector';
import { buildBridge } from '../bridge/bridge-builder.ts';
import { RuleGraphQueryApi } from '../query/rule-graph-query-api.ts';

const T = 60_000;
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const EVERY_FILE = [{ id: 'any', description: 'one hit per covered file', forbidMatch: '.' }];
const CONVENTIONS = [
  { id: 'c.all', title: 'all', kind: 'naming', severity: 'warning', rules: EVERY_FILE },
  { id: 'c.glob', title: 'glob', kind: 'naming', severity: 'warning', appliesTo: { fileGlobs: ['src/**/*.ts', '!src/gen/**'] }, rules: EVERY_FILE },
  { id: 'c.ts', title: 'ts', kind: 'naming', severity: 'warning', appliesTo: { profileIds: ['has-typescript'], languages: ['typescript'] }, rules: EVERY_FILE },
  { id: 'c.turbo', title: 'turbo', kind: 'naming', severity: 'warning', appliesTo: { profileIds: ['has-turborepo'] }, rules: EVERY_FILE },
  { id: 'c.angular', title: 'angular', kind: 'naming', severity: 'warning', appliesTo: { frameworks: ['angular'] }, rules: EVERY_FILE },
];

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r78-bridge-'));
  roots.push(root);
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
    'tsconfig.json': '{}',
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx' };\n",
    'sharkcraft/conventions.ts': `export default ${JSON.stringify(CONVENTIONS, null, 2)};\n`,
    'src/a.ts': "import { d } from './deep/d.ts';\nexport const a = d;\n",
    'src/deep/d.ts': 'export const d = 1;\n',
    'src/gen/g.ts': 'export const g = 1;\n',
    'root.ts': "import { a } from './src/a.ts';\nexport const r = a;\n",
    'src/util.js': 'export const u = 1;\n',
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

describe('check ≡ bridge — one answer to "which files does this convention cover?"', () => {
  test(
    'for every convention: bridge edges ≡ check hits ≡ conventionScope, over the graph file list',
    async () => {
      const root = project();
      buildFullIndex({ projectRoot: root });
      const inspection = await inspectSharkcraft({ cwd: root });
      await buildBridge({ projectRoot: root, inspection });
      const graphFiles = [...new GraphStore(root).loadSnapshot().nodes.values()]
        .filter((n) => n.kind === NodeKind.File && n.path)
        .map((n) => n.path!)
        .sort();
      // Not blind: the graph indexed the fixture's files.
      expect(graphFiles).toEqual(expect.arrayContaining(['root.ts', 'src/a.ts', 'src/deep/d.ts', 'src/gen/g.ts']));

      const api = RuleGraphQueryApi.fromStores(root);
      const bridged = new Map<string, string[]>();
      for (const f of graphFiles) {
        for (const hit of api.forFile(f)?.rules ?? []) {
          if (!hit.target.id.startsWith('convention:')) continue;
          const id = hit.target.id.slice('convention:'.length);
          bridged.set(id, [...(bridged.get(id) ?? []), f]);
        }
      }
      const report = await checkConventionsAgainstFiles(inspection, graphFiles);
      const checked = new Map<string, string[]>();
      for (const h of report.hits) checked.set(h.conventionId, [...(checked.get(h.conventionId) ?? []), h.file]);

      const conventions = await listConventions(inspection);
      expect(conventions.map((e) => e.convention.id)).toEqual(CONVENTIONS.map((c) => c.id));
      for (const e of conventions) {
        const id = e.convention.id;
        const scope = conventionScope(e.convention, inspection, graphFiles);
        const row = {
          id,
          bridge: [...(bridged.get(id) ?? [])].sort(),
          check: [...(checked.get(id) ?? [])].sort(),
        };
        expect(row).toEqual({ id, bridge: [...scope.files].sort(), check: [...scope.files].sort() });
      }

      // …and the answer itself is the documented one.
      expect([...(bridged.get('c.all') ?? [])].sort()).toEqual(graphFiles); // no fileGlobs → every file (the bridge dropped it)
      expect(bridged.get('c.glob')).toContain('src/a.ts'); // `src/**/*.ts` matches a direct child (check missed it)
      expect(bridged.get('c.glob')).not.toContain('src/gen/g.ts'); // `!` subtracts
      expect(bridged.get('c.glob')).not.toContain('root.ts');
      expect(bridged.get('c.ts')).toContain('root.ts');
      expect(bridged.get('c.ts') ?? []).not.toContain('src/util.js'); // languages: typescript only
      expect(bridged.has('c.turbo')).toBe(false); // an undetected profile covers nothing
      expect(bridged.has('c.angular')).toBe(false); // an undetected framework covers nothing
      expect(report.notApplicable.map((n) => n.conventionId).sort()).toEqual(['c.angular', 'c.turbo']);
    },
    T,
  );
});
