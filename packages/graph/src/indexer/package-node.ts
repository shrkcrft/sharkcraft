import type { INode } from '../schema/node.ts';
import { NodeKind } from '../schema/node-kind.ts';
import type { IWorkspacePackage } from './detect-workspace.ts';
import { resolvePackageEntryFile } from './resolve-imports.ts';

/**
 * The ONE package-node builder, shared by the full and incremental builders so
 * the two can never write different package data.
 *
 * `data.entry` is the raw package.json field (main ?? module ?? types) — kept
 * for compatibility. `data.entryFile` is what a bare `import … from '<pkg>'`
 * actually resolves to ({@link resolvePackageEntryFile}), or `null` when
 * nothing resolves. The key is ALWAYS written, so a reader can tell "this
 * package has no resolvable entry" (`null`) from "this index predates
 * entryFile" (key absent).
 */
export function buildPackageNode(pkg: IWorkspacePackage, projectRoot: string): INode {
  return {
    id: `package:${pkg.name}`,
    kind: NodeKind.Package,
    label: pkg.name,
    path: pkg.dir,
    data: {
      ...(pkg.entry ? { entry: pkg.entry } : {}),
      entryFile: resolvePackageEntryFile(pkg, projectRoot) ?? null,
    },
  };
}
