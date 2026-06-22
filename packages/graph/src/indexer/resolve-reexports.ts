import { createHash } from 'node:crypto';
import type { IEdge } from '../schema/edge.ts';
import { EdgeKind } from '../schema/edge-kind.ts';
import type { INode } from '../schema/node.ts';
import { NodeKind } from '../schema/node-kind.ts';

interface IReExport {
  name: string;
  star: boolean;
  specifier: string;
}

/**
 * Resolve barrel re-export chains so a reference/call edge that targets a
 * symbol re-exported through a package barrel points at the REAL declaring
 * symbol instead of a phantom `symbol:<barrel>#<name>` that never existed.
 *
 * Why this matters: cross-package consumers import from a package barrel
 * (`import { X } from '@scope/pkg'`), which the resolver maps to the barrel
 * `index.ts`. The binder then targets `symbol:<barrel>#X` — but `X` is
 * declared in a sub-file the barrel re-exports (`export * from './x'` /
 * `export { X } from './x'`), so `callersOf(<real X>)` misses every one of
 * those consumers and `graph callers` returns a confidently-wrong all-clear.
 * This pass rewrites those edges to the real symbol id.
 *
 * Conservative + deterministic:
 *   - Only edges whose target symbol does NOT exist (a phantom) are
 *     considered; every valid edge is returned untouched.
 *   - Re-export chains are followed with a visited-set cycle guard, so a
 *     re-export cycle terminates instead of looping.
 *   - Renamed re-exports (`export { a as b } from './x'`) are intentionally
 *     left unresolved — the exposed name differs from the declaration, so
 *     there is no safe deterministic match.
 *
 * Target file paths come from the `ImportsFile` edges the barrel already
 * emits for its `export … from` specifiers, so this is a pure pass over
 * `(nodes, edges)` with no extra resolver state — it runs identically in the
 * full and incremental builders. The caller is responsible for de-duping
 * (a rewrite can collide a rewritten edge id with an existing one).
 */
export function resolveReExportedReferenceEdges(
  nodes: readonly INode[],
  edges: readonly IEdge[],
): IEdge[] {
  const symbolIds = new Set<string>();
  for (const n of nodes) if (n.kind === NodeKind.Symbol) symbolIds.add(n.id);

  // file path → (re-export specifier → resolved target file path).
  const importTargets = new Map<string, Map<string, string>>();
  // file path → its re-exports.
  const reExportsByFile = new Map<string, IReExport[]>();
  for (const e of edges) {
    if (e.kind === EdgeKind.ImportsFile) {
      if (!e.from.startsWith('file:') || !e.to.startsWith('file:')) continue;
      const spec = e.data?.['specifier'];
      if (typeof spec !== 'string') continue;
      const from = e.from.slice('file:'.length);
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
      const from = e.from.slice('file:'.length);
      let arr = reExportsByFile.get(from);
      if (!arr) {
        arr = [];
        reExportsByFile.set(from, arr);
      }
      arr.push({ name, star: e.data?.['star'] === true, specifier });
    }
  }

  const resolve = (file: string, name: string, visited: Set<string>): string | undefined => {
    const key = `${file}#${name}`;
    if (visited.has(key)) return undefined;
    visited.add(key);
    const direct = `symbol:${file}#${name}`;
    if (symbolIds.has(direct)) return direct;
    const reExports = reExportsByFile.get(file);
    const specMap = importTargets.get(file);
    if (!reExports || !specMap) return undefined;
    for (const re of reExports) {
      if (!re.star && re.name !== name) continue;
      const targetPath = specMap.get(re.specifier);
      if (!targetPath) continue;
      const r = resolve(targetPath, name, visited);
      if (r) return r;
    }
    return undefined;
  };

  return edges.map((e) => {
    // Re-target the same symbol-pointing edges that cross a package barrel:
    // references/calls AND the typed heritage edges. Without heritage here, a
    // `class X implements I` where `I` is imported from a package barrel would
    // point at the unresolved barrel placeholder and `subtypesOf(I)` would
    // silently return nothing cross-package.
    if (
      e.kind !== EdgeKind.CallsSymbol &&
      e.kind !== EdgeKind.ReferencesSymbol &&
      e.kind !== EdgeKind.ExtendsSymbol &&
      e.kind !== EdgeKind.ImplementsSymbol
    ) {
      return e;
    }
    if (!e.to.startsWith('symbol:') || symbolIds.has(e.to)) return e;
    const body = e.to.slice('symbol:'.length);
    const hash = body.lastIndexOf('#');
    if (hash <= 0) return e;
    const resolved = resolve(body.slice(0, hash), body.slice(hash + 1), new Set());
    if (!resolved || resolved === e.to) return e;
    return { ...e, to: resolved, id: edgeId(e.from, resolved, e.kind) };
  });
}

function edgeId(from: string, to: string, kind: EdgeKind): string {
  return createHash('sha1').update(`${from}|${to}|${kind}`).digest('hex');
}
