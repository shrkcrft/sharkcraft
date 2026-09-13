import type { IEdge } from '../schema/edge.ts';
import { EdgeKind } from '../schema/edge-kind.ts';
import type { INode } from '../schema/node.ts';
import { NodeKind } from '../schema/node-kind.ts';
import type { IReExportIndex } from './re-export-index-model.ts';

interface IReExport {
  name: string;
  /**
   * Original name in the target module for a renamed re-export
   * (`export { Orig as Exposed }` → `Orig`). `default` for
   * `export { default as Exposed }`. Absent when exposed === original.
   */
  localName?: string;
  star: boolean;
  /** `export * as ns from` — binds a module, not a declaration named `name`. */
  namespace?: boolean;
  specifier: string;
}

/**
 * Build the barrel re-export index over `(nodes, edges)` — the ONE transitive
 * barrel-chain follower.
 *
 * Moved verbatim out of `resolveReExportedReferenceEdges` so the public-surface
 * walk can read the same chain resolution the reference rewriter uses, instead
 * of a second walker that would agree only by coincidence.
 *
 * Target file paths come from the `ImportsFile` edges a barrel already emits
 * for its `export … from` specifiers, so this is a pure pass over the snapshot
 * with no extra resolver state — identical in the full and incremental
 * builders and at query time.
 */
export function buildReExportIndex(nodes: readonly INode[], edges: readonly IEdge[]): IReExportIndex {
  const symbolIds = new Set<string>();
  // file path → its declared default-export name (where one is identifiable).
  // Lets a `export { default as Foo } from './x'` re-export map the `default`
  // placeholder to the real declaration name — same source the binder uses.
  const defaultExportNameByPath = new Map<string, string>();
  for (const n of nodes) {
    if (n.kind === NodeKind.Symbol) symbolIds.add(n.id);
    else if (n.kind === NodeKind.File && typeof n.path === 'string') {
      const dflt = n.data?.['defaultExportName'];
      if (typeof dflt === 'string') defaultExportNameByPath.set(n.path, dflt);
    }
  }

  // file path → (re-export specifier → resolved target file path).
  const importTargets = new Map<string, Map<string, string>>();
  // file path → the specifiers it imports from OUTSIDE the workspace
  // (`external:<spec>` / `asset:<spec>` targets) — to tell a third-party
  // re-export from a local one the index could not follow.
  const externalTargets = new Map<string, Set<string>>();
  // file path → its re-exports.
  const reExportsByFile = new Map<string, IReExport[]>();
  for (const e of edges) {
    if (e.kind === EdgeKind.ImportsFile) {
      if (!e.from.startsWith('file:')) continue;
      const spec = e.data?.['specifier'];
      if (typeof spec !== 'string') continue;
      const from = e.from.slice('file:'.length);
      if (e.to.startsWith('external:') || e.to.startsWith('asset:')) {
        let s = externalTargets.get(from);
        if (!s) {
          s = new Set();
          externalTargets.set(from, s);
        }
        s.add(spec);
        continue;
      }
      if (!e.to.startsWith('file:')) continue;
      let m = importTargets.get(from);
      if (!m) {
        m = new Map();
        importTargets.set(from, m);
      }
      if (!m.has(spec)) m.set(spec, e.to.slice('file:'.length));
    } else if (e.kind === EdgeKind.ReExportsSymbol) {
      if (!e.from.startsWith('file:')) continue;
      const name = e.data?.['name'];
      const specifier = e.data?.['specifier'];
      if (typeof name !== 'string' || typeof specifier !== 'string') continue;
      const localNameRaw = e.data?.['localName'];
      const localName = typeof localNameRaw === 'string' ? localNameRaw : undefined;
      const from = e.from.slice('file:'.length);
      let arr = reExportsByFile.get(from);
      if (!arr) {
        arr = [];
        reExportsByFile.set(from, arr);
      }
      arr.push({
        name,
        ...(localName ? { localName } : {}),
        star: e.data?.['star'] === true,
        ...(e.data?.['namespace'] === true ? { namespace: true } : {}),
        specifier,
      });
    }
  }

  // `trail`, when given, collects the barrel files on the SUCCESSFUL path
  // (pushed before descending, popped when a branch fails). `deadEnds`, when
  // given, collects every candidate hop whose specifier resolved to no indexed
  // file. Neither changes what is resolved — `resolveName` passes none,
  // exactly as before the move.
  const resolve = (
    file: string,
    name: string,
    visited: Set<string>,
    trail: string[] | undefined,
    deadEnds?: { file: string; specifier: string }[],
  ): string | undefined => {
    // A `default` placeholder (from `export { default as Foo } from './x'`,
    // threaded as the re-export's `localName`) names no declared symbol
    // directly — map it to THIS file's actual default-export name first.
    let resolveName = name;
    if (resolveName === 'default') {
      const dflt = defaultExportNameByPath.get(file);
      if (dflt) resolveName = dflt;
    }
    const key = `${file}#${resolveName}`;
    if (visited.has(key)) return undefined;
    visited.add(key);
    const direct = `symbol:${file}#${resolveName}`;
    if (symbolIds.has(direct)) return direct;
    const reExports = reExportsByFile.get(file);
    const specMap = importTargets.get(file);
    if (!reExports) return undefined;
    for (const re of reExports) {
      // A namespace re-export binds a whole module; it declares no `name`.
      if (re.namespace === true) continue;
      if (!re.star && re.name !== resolveName) continue;
      const targetPath = specMap?.get(re.specifier);
      if (!targetPath) {
        deadEnds?.push({ file, specifier: re.specifier });
        continue;
      }
      // Star re-exports forward the SAME name; a named re-export recurses with
      // the ORIGINAL name (`localName`) so `export { FooImpl as Foo }` lands on
      // `symbol:<x>#FooImpl` rather than a `Foo` that was never declared there.
      const nextName = re.star ? resolveName : (re.localName ?? re.name);
      trail?.push(file);
      const r = resolve(targetPath, nextName, visited, trail, deadEnds);
      if (r) return r;
      trail?.pop();
    }
    return undefined;
  };

  return {
    hasSymbol: (symbolId) => symbolIds.has(symbolId),
    reExportsOf: (file) => reExportsByFile.get(file) ?? [],
    targetOf: (file, specifier) => importTargets.get(file)?.get(specifier),
    isExternalTarget: (file, specifier) => externalTargets.get(file)?.has(specifier) === true,
    defaultExportNameOf: (file) => defaultExportNameByPath.get(file),
    resolveName: (file, name) => resolve(file, name, new Set(), undefined),
    resolveTrace: (file, name) => {
      const trail: string[] = [];
      const symbolId = resolve(file, name, new Set(), trail);
      return symbolId ? { symbolId, via: trail } : undefined;
    },
    deadEndsOf: (file, name) => {
      const deadEnds: { file: string; specifier: string }[] = [];
      return resolve(file, name, new Set(), undefined, deadEnds) === undefined ? deadEnds : [];
    },
  };
}
