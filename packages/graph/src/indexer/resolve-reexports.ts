import { createHash } from 'node:crypto';
import type { IEdge } from '../schema/edge.ts';
import { EdgeKind } from '../schema/edge-kind.ts';
import type { INode } from '../schema/node.ts';
import { buildReExportIndex } from './re-export-index.ts';

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
 *   - Renamed re-exports (`export { Orig as Exposed } from './x'`) ARE
 *     resolved: the extractor threads the ORIGINAL name (`localName`) onto the
 *     re-export edge, so the chain recurses with `Orig` and lands on the real
 *     `symbol:<x>#Orig` instead of giving up on a name that never existed
 *     there. `export { default as Foo } from './x'` is handled too — the
 *     `default` placeholder maps to the target file's actual default-export
 *     name (the same per-file default map the binder uses).
 *
 * The chain follower itself lives in {@link buildReExportIndex} — the one
 * barrel-chain authority, shared with the public-surface walk — so this is a
 * thin caller over it. It runs identically in the full and incremental
 * builders. The caller is responsible for de-duping (a rewrite can collide a
 * rewritten edge id with an existing one).
 */
export function resolveReExportedReferenceEdges(
  nodes: readonly INode[],
  edges: readonly IEdge[],
): IEdge[] {
  const index = buildReExportIndex(nodes, edges);
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
    if (!e.to.startsWith('symbol:') || index.hasSymbol(e.to)) return e;
    const body = e.to.slice('symbol:'.length);
    const hash = body.lastIndexOf('#');
    if (hash <= 0) return e;
    const resolved = index.resolveName(body.slice(0, hash), body.slice(hash + 1));
    if (!resolved || resolved === e.to) return e;
    return { ...e, to: resolved, id: edgeId(e.from, resolved, e.kind) };
  });
}

function edgeId(from: string, to: string, kind: EdgeKind): string {
  return createHash('sha1').update(`${from}|${to}|${kind}`).digest('hex');
}
