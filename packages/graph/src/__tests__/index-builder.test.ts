import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFullIndex } from '../indexer/index-builder.ts';
import { GraphQueryApi } from '../query/query-api.ts';
import { EdgeKind } from '../schema/edge-kind.ts';
import { NodeKind } from '../schema/node-kind.ts';

function setupWorkspaceFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-graph-builder-'));
  // Two-package workspace with one cross-package import.
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo-root', workspaces: ['packages/*'] }, null, 2),
  );
  mkdirSync(join(root, 'packages', 'alpha', 'src'), { recursive: true });
  mkdirSync(join(root, 'packages', 'beta', 'src'), { recursive: true });
  writeFileSync(
    join(root, 'packages', 'alpha', 'package.json'),
    JSON.stringify({ name: '@demo/alpha', main: 'src/index.ts' }, null, 2),
  );
  writeFileSync(
    join(root, 'packages', 'beta', 'package.json'),
    JSON.stringify({ name: '@demo/beta', main: 'src/index.ts' }, null, 2),
  );
  writeFileSync(
    join(root, 'packages', 'alpha', 'src', 'index.ts'),
    [
      "export interface IAlpha {",
      "  name: string;",
      "}",
      "export function alpha(): IAlpha {",
      "  return { name: 'a' };",
      "}",
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'packages', 'beta', 'src', 'index.ts'),
    [
      "import { alpha } from '@demo/alpha';",
      "export function useAlpha() {",
      "  return alpha();",
      "}",
    ].join('\n'),
  );
  // Add a relative import inside the same package.
  writeFileSync(
    join(root, 'packages', 'beta', 'src', 'helper.ts'),
    [
      "import { useAlpha } from './index.ts';",
      "export const helper = useAlpha;",
    ].join('\n'),
  );
  return root;
}

describe('buildFullIndex', () => {
  test('indexes a two-package workspace end-to-end', () => {
    const root = setupWorkspaceFixture();
    try {
      const result = buildFullIndex({ projectRoot: root });
      expect(result.manifest.filesIndexed).toBe(3);
      expect(result.manifest.workspacePackages).toEqual(['@demo/alpha', '@demo/beta']);
      expect(result.manifest.nodesByKind['file']).toBe(3);
      expect(result.manifest.nodesByKind['package']).toBe(2);
      expect((result.manifest.edgesByKind['imports-file'] ?? 0)).toBeGreaterThanOrEqual(2);
      expect(result.manifest.edgesByKind['belongs-to-package']).toBe(3);

      const q = GraphQueryApi.fromStore(root);
      expect(q.status().fileCount).toBe(3);

      const betaIndex = q.findFile('packages/beta/src/index.ts');
      expect(betaIndex).toBeDefined();
      const importsFromBeta = q.importsFrom(betaIndex!.id);
      const alphaIndex = importsFromBeta.find(
        (n) => n.path === 'packages/alpha/src/index.ts',
      );
      expect(alphaIndex).toBeDefined();
      expect(alphaIndex!.kind).toBe(NodeKind.File);

      const alphaImporters = q.importersOf(alphaIndex!.id);
      expect(alphaImporters.length).toBeGreaterThanOrEqual(1);

      const alphaSymbols = q.symbolsIn(alphaIndex!.id);
      const names = alphaSymbols.map((s) => s.label).sort();
      expect(names).toContain('alpha');
      expect(names).toContain('IAlpha');

      const deps = q.packageDeps('@demo/beta');
      expect(deps.map((d) => d.label)).toContain('@demo/alpha');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('flags external imports as external resolution kind', () => {
    const root = setupWorkspaceFixture();
    try {
      writeFileSync(
        join(root, 'packages', 'alpha', 'src', 'with-external.ts'),
        "import { something } from 'left-pad';\nexport const x = 1;",
      );
      const { manifest } = buildFullIndex({ projectRoot: root });
      expect(manifest.filesIndexed).toBe(4);
      const q = GraphQueryApi.fromStore(root);
      const n = q.findFile('packages/alpha/src/with-external.ts')!;
      const neighbours = q.neighbours(n.id)!;
      const externalEdge = neighbours.out.find(
        (o) => o.edge.kind === EdgeKind.ImportsFile && o.edge.to === 'external:left-pad',
      );
      expect(externalEdge).toBeDefined();
      expect((externalEdge!.edge.data as { resolutionKind: string }).resolutionKind).toBe('external');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
