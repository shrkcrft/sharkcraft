import type { INode } from '../schema/node.ts';
import type { IPackageEntryDivergence } from './package-entry-divergence-record.ts';
import { NodeKind } from '../schema/node-kind.ts';
import { detectWorkspacePackages } from './detect-workspace.ts';
import { resolvePackageEntryFile } from './resolve-imports.ts';

/**
 * Workspace packages whose INDEXED record no longer matches the working tree —
 * sorted package names.
 *
 * A package node's `entryFile` is an index input no source fingerprint covers:
 * it is derived from package.json (`main` / `module` / `types`), the root
 * `workspaces` list and which files exist. Editing only a package.json changes
 * what a bare `import … from '<pkg>'` resolves to — and so the public export
 * surface — while every source file stays byte-identical. This is the half of
 * freshness the file walk cannot see.
 *
 * Diverged = in the workspace but not the index, in the index but no longer a
 * workspace package, moved to another directory, or its entry now resolves
 * (through the SAME resolver the index used, {@link resolvePackageEntryFile})
 * to a different file. An index that predates `entryFile` has nothing stored to
 * compare; the surface walk already reports that ("predates package
 * entryFile"), so only its package set is compared here.
 */
export function detectPackageEntryDivergence(projectRoot: string, indexedNodes: Iterable<INode>): string[] {
  return detectPackageEntryDivergenceDetail(projectRoot, indexedNodes).map((d) => d.name);
}

/**
 * {@link detectPackageEntryDivergence} with WHAT diverged per package — the one
 * derivation; the name list is exactly these records' names. Sorted by name.
 */
export function detectPackageEntryDivergenceDetail(
  projectRoot: string,
  indexedNodes: Iterable<INode>,
): IPackageEntryDivergence[] {
  const indexed = new Map<string, INode>();
  for (const n of indexedNodes) {
    if (n.kind === NodeKind.Package) indexed.set(n.label, n);
  }
  const storedEntryOf = (node: INode): { storedEntry?: string | null } => {
    const data = node.data ?? {};
    if (!Object.prototype.hasOwnProperty.call(data, 'entryFile')) return {};
    const stored = data['entryFile'];
    return { storedEntry: typeof stored === 'string' ? stored : null };
  };
  const changed = new Map<string, IPackageEntryDivergence>();
  const current = new Set<string>();
  for (const pkg of detectWorkspacePackages(projectRoot)) {
    current.add(pkg.name);
    const node = indexed.get(pkg.name);
    if (node === undefined) {
      changed.set(pkg.name, { name: pkg.name, currentDir: pkg.dir });
      continue;
    }
    if ((node.path ?? '') !== pkg.dir) {
      changed.set(pkg.name, {
        name: pkg.name,
        storedDir: node.path ?? '',
        currentDir: pkg.dir,
        ...storedEntryOf(node),
      });
      continue;
    }
    const data = node.data ?? {};
    if (!Object.prototype.hasOwnProperty.call(data, 'entryFile')) continue;
    const stored = data['entryFile'] ?? null;
    const now = resolvePackageEntryFile(pkg, projectRoot) ?? null;
    if (stored !== now) {
      changed.set(pkg.name, {
        name: pkg.name,
        storedDir: node.path ?? '',
        currentDir: pkg.dir,
        storedEntry: typeof stored === 'string' ? stored : null,
        currentEntry: now,
      });
    }
  }
  for (const [name, node] of indexed) {
    if (!current.has(name)) changed.set(name, { name, storedDir: node.path ?? '', ...storedEntryOf(node) });
  }
  return [...changed.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
