import {
  UnfollowedReExportKind,
  type IPublicExport,
  type IPublicExportSurface,
  type IUnfollowedReExport,
} from '@shrkcrft/core';
import { SymbolVisibility } from '@shrkcrft/inspector';
import type { IEdge } from '../schema/edge.ts';
import type { INode } from '../schema/node.ts';
import { NodeKind } from '../schema/node-kind.ts';
import { buildReExportIndex } from '../indexer/re-export-index.ts';
import type { IReExportIndex } from '../indexer/re-export-index-model.ts';
import type { IModuleExportWalk } from './module-export-walk.ts';

/** The ESM name a package's default export is imported under. */
const DEFAULT_EXPORT = 'default';

/** `declKind` of a namespace re-export (`export * as ns from`). */
const NAMESPACE_KIND = 'namespace';

/**
 * Enumerate every construct reachable from a workspace package's ROOT entry —
 * the file a bare `import … from '<package>'` resolves to — directly or through
 * barrel re-exports. The one public-surface authority.
 *
 * Nothing here re-derives module resolution:
 *   - Roots are the package nodes' `entryFile` (written at index time by the
 *     SAME resolver every consumer's bare import goes through), accepted only
 *     when it is an indexed file.
 *   - Each root is walked by {@link createModuleExportWalker} — the same walk
 *     a non-root import specifier is checked with — and names are followed with
 *     the re-export index, the chain follower the reference-edge rewriter uses,
 *     so "which declaration does this name land on?" has one answer across
 *     `graph callers` and the surface.
 *
 * Never silent: a package that cannot be walked goes to `packagesWithoutEntry`
 * with a reason (an index that predates `entryFile` says so, rather than
 * guessing), and every re-export that lands on no indexed declaration is listed
 * in `unfollowedReExports` — `external` (outside the workspace) or `unresolved`
 * (a local module or name the index could not follow).
 *
 * Known limit: package.json `exports` subpath maps are not walked — only the
 * root entry, the same file the consumer edges point at.
 */
export function enumeratePublicSurface(
  nodes: readonly INode[],
  edges: readonly IEdge[],
  index: IReExportIndex = buildReExportIndex(nodes, edges),
): IPublicExportSurface {
  const walk = createModuleExportWalker(nodes, index);
  const files = new Set<string>();
  const packages: INode[] = [];
  for (const n of nodes) {
    if (n.kind === NodeKind.File && typeof n.path === 'string') files.add(n.path);
    else if (n.kind === NodeKind.Package) packages.push(n);
  }
  packages.sort((a, b) => compare(a.label, b.label));

  const roots: { package: string; dir: string; entryFile: string }[] = [];
  const packagesWithoutEntry: { package: string; dir: string; reason: string }[] = [];
  const exports: IPublicExport[] = [];
  const unfollowedReExports: IUnfollowedReExport[] = [];

  for (const pkg of packages) {
    const dir = pkg.path ?? '';
    const root = rootEntryOf(pkg, files);
    if (root.file === undefined) {
      packagesWithoutEntry.push({ package: pkg.label, dir, reason: root.reason });
      continue;
    }
    roots.push({ package: pkg.label, dir, entryFile: root.file });
    const w = walk(root.file);
    for (const x of w.exports) {
      exports.push({
        name: x.name,
        package: pkg.label,
        entryFile: root.file,
        declaredIn: x.declaredIn,
        ...(x.line !== undefined ? { line: x.line } : {}),
        declKind: x.declKind,
        symbolId: x.symbolId,
        via: x.via,
        ...(x.isDefault === true ? { isDefault: true } : {}),
        ...(x.namespace === true ? { namespace: true } : {}),
      });
    }
    for (const u of w.unfollowed) unfollowedReExports.push({ package: pkg.label, ...u });
  }

  exports.sort((a, b) => compare(a.package, b.package) || compare(a.name, b.name));
  return {
    roots,
    packagesWithoutEntry,
    exports,
    unresolvedReExports: unfollowedReExports.length,
    unfollowedReExports,
  };
}

/**
 * The ESM export walk of ONE module: what `import … from '<it>'` can bind.
 * Build once per snapshot; each call walks one module.
 *
 * ESM semantics: a module exposes its own exported declarations, its named
 * re-exports (under the EXPOSED name), its namespace re-exports (`export * as
 * ns` — the name binds the whole target module), and — through `export *` —
 * every non-default name of the target. A default export is exposed only by the
 * walked module itself (`export *` never forwards it). A re-export cycle
 * terminates.
 */
export function createModuleExportWalker(
  nodes: readonly INode[],
  index: IReExportIndex,
): (file: string) => IModuleExportWalk {
  const symbols = new Map<string, INode>();
  const exportedByFile = new Map<string, INode[]>();
  for (const n of nodes) {
    if (n.kind !== NodeKind.Symbol) continue;
    symbols.set(n.id, n);
    if (n.data?.['isExported'] === true && typeof n.path === 'string') {
      const list = exportedByFile.get(n.path);
      if (list) list.push(n);
      else exportedByFile.set(n.path, [n]);
    }
  }
  const kindOf = (file: string, specifier: string): UnfollowedReExportKind =>
    index.isExternalTarget(file, specifier) ? UnfollowedReExportKind.External : UnfollowedReExportKind.Unresolved;

  return (rootFile: string): IModuleExportWalk => {
    // 1. Which names does the module expose? (ESM export resolution, names only.)
    const named: string[] = [];
    const seenNames = new Set<string>();
    /** name → the namespace re-export that bound it, when that is how it was first exposed. */
    const namespaces = new Map<string, { file: string; specifier: string; via: string[] }>();
    /** name → the named re-export that first exposed it (labels and classifies one that cannot be followed). */
    const origins = new Map<string, { file: string; specifier: string; localName?: string }>();
    const unfollowed: Omit<IUnfollowedReExport, 'package'>[] = [];
    let exposesDefault = false;
    const expose = (name: string): boolean => {
      if (seenNames.has(name)) return false;
      seenNames.add(name);
      named.push(name);
      return true;
    };
    const visitedFiles = new Set<string>();
    const collect = (file: string, atRoot: boolean, trail: readonly string[]): void => {
      if (visitedFiles.has(file)) return; // a re-export cycle terminates here
      visitedFiles.add(file);
      for (const s of exportedByFile.get(file) ?? []) {
        if (s.data?.['visibility'] === SymbolVisibility.Default) {
          if (atRoot) exposesDefault = true;
          continue;
        }
        expose(s.label);
      }
      // `export default Foo;` names a LOCAL declaration — still the default.
      if (atRoot && index.defaultExportNameOf(file) !== undefined) exposesDefault = true;
      for (const re of index.reExportsOf(file)) {
        if (re.star) {
          const target = index.targetOf(file, re.specifier);
          if (target === undefined) {
            unfollowed.push({ file, specifier: re.specifier, name: '*', kind: kindOf(file, re.specifier) });
            continue;
          }
          collect(target, false, [...trail, file]);
          continue;
        }
        if (re.name === DEFAULT_EXPORT) {
          if (atRoot) exposesDefault = true;
          continue;
        }
        if (!expose(re.name)) continue;
        if (re.namespace === true) namespaces.set(re.name, { file, specifier: re.specifier, via: [...trail, file] });
        else {
          origins.set(re.name, {
            file,
            specifier: re.specifier,
            ...(re.localName !== undefined ? { localName: re.localName } : {}),
          });
        }
      }
    };
    collect(rootFile, true, []);

    // 2. Where does each exposed name land? One chain follower decides.
    const exports: Omit<IPublicExport, 'package' | 'entryFile'>[] = [];
    const emitted = new Set<string>();
    const keys = [...named, ...(exposesDefault ? [DEFAULT_EXPORT] : [])];
    for (const key of keys) {
      const ns = key === DEFAULT_EXPORT ? undefined : namespaces.get(key);
      if (ns !== undefined) {
        const target = index.targetOf(ns.file, ns.specifier);
        if (target === undefined) {
          unfollowed.push({ file: ns.file, specifier: ns.specifier, name: key, kind: kindOf(ns.file, ns.specifier) });
          continue;
        }
        if (emitted.has(key)) continue;
        emitted.add(key);
        exports.push({
          name: key,
          declaredIn: target,
          declKind: NAMESPACE_KIND,
          symbolId: `file:${target}`,
          via: ns.via,
          namespace: true,
        });
        continue;
      }
      const trace = index.resolveTrace(rootFile, key);
      const sym = trace ? symbols.get(trace.symbolId) : undefined;
      if (!trace || !sym || typeof sym.path !== 'string') {
        // Never silent: say which re-export introduced the name, and whether its
        // chain left the workspace (external) or broke inside it (unresolved).
        const origin = origins.get(key);
        let at: { file: string; specifier: string };
        let external: boolean;
        if (origin !== undefined) {
          at = origin;
          if (index.isExternalTarget(origin.file, origin.specifier)) {
            external = true;
          } else {
            const target = index.targetOf(origin.file, origin.specifier);
            const dead = target === undefined ? [] : index.deadEndsOf(target, origin.localName ?? key);
            external = dead.length > 0 && dead.every((d) => index.isExternalTarget(d.file, d.specifier));
          }
        } else {
          const dead = index.deadEndsOf(rootFile, key);
          at = dead[0] ?? { file: rootFile, specifier: '' };
          external = dead.length > 0 && dead.every((d) => index.isExternalTarget(d.file, d.specifier));
        }
        unfollowed.push({
          file: at.file,
          specifier: at.specifier,
          name: key,
          kind: external ? UnfollowedReExportKind.External : UnfollowedReExportKind.Unresolved,
        });
        continue;
      }
      const isDefault = key === DEFAULT_EXPORT;
      const name = isDefault ? sym.label : key;
      // A named export wins over the default alias of the same name.
      if (emitted.has(name)) continue;
      emitted.add(name);
      const declKind = sym.data?.['declKind'];
      exports.push({
        name,
        declaredIn: sym.path,
        ...(typeof sym.line === 'number' ? { line: sym.line } : {}),
        declKind: typeof declKind === 'string' ? declKind : 'unknown',
        symbolId: sym.id,
        via: trace.via,
        ...(isDefault ? { isDefault: true } : {}),
      });
    }
    unfollowed.sort((a, b) => compare(a.file, b.file) || compare(a.specifier, b.specifier) || compare(a.name, b.name));
    return { file: rootFile, exports, unfollowed };
  };
}

/**
 * The indexed root file of a package, or why there is none. An index built
 * before `entryFile` existed is accepted only when its raw `entry` is itself an
 * indexed file — identical to the resolver's first branch — and otherwise says
 * the index is too old, rather than guessing a `src/index.*`.
 */
function rootEntryOf(
  pkg: INode,
  files: ReadonlySet<string>,
): { file: string; reason?: undefined } | { file?: undefined; reason: string } {
  const data = pkg.data ?? {};
  if (Object.prototype.hasOwnProperty.call(data, 'entryFile')) {
    const entryFile = data['entryFile'];
    if (typeof entryFile === 'string' && entryFile.length > 0) {
      return files.has(entryFile)
        ? { file: entryFile }
        : {
            reason: `its entry resolves to ${entryFile}, which the index does not cover (a skipped directory or a non-source file)`,
          };
    }
    return {
      reason:
        'no resolvable entry — package.json main/module/types names no existing file, and there is no src/index.*',
    };
  }
  const legacy = data['entry'];
  if (typeof legacy === 'string' && files.has(legacy)) return { file: legacy };
  return { reason: 'the index predates package entryFile — run `shrk graph index`' };
}

/** Locale-independent ordering, so the surface is byte-stable across machines. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
