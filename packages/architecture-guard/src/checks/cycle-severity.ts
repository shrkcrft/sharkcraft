import { EdgeKind, type GraphQueryApi, type IEdge } from '@shrkcrft/graph';
import type { IArchViolation } from '../schema/violation.ts';

/**
 * Find directed cycles in the `imports-file` graph (Tarjan SCC) and
 * report each as a violation. Severity scales with cycle size: 2-node
 * cycle = warning (often refactor-friendly), 3+ = error.
 *
 * Type-only import edges (`import type`, `export type … from`) are excluded by
 * default — they are erased at emit time and cannot cause a runtime cycle, so
 * counting them would produce a phantom "critical" cycle that can never be
 * driven to zero. Pass `includeTypeEdges` to audit them.
 */
export function detectCycles(
  api: GraphQueryApi,
  options: { includeTypeEdges?: boolean } = {},
): readonly IArchViolation[] {
  const includeTypeEdges = options.includeTypeEdges === true;
  // Build adjacency from imports-file edges among file nodes only.
  const adj = new Map<string, string[]>();
  for (const f of api.allFiles()) {
    const out = api.neighbours(f.id);
    if (!out) continue;
    const list: string[] = [];
    for (const e of out.out) {
      if (e.edge.kind !== EdgeKind.ImportsFile) continue;
      if (!includeTypeEdges && e.edge.data?.['typeOnly'] === true) continue;
      if (e.edge.to.startsWith('file:')) list.push(e.edge.to);
    }
    adj.set(f.id, list);
  }
  const sccs = stronglyConnectedComponents(adj);
  const violations: IArchViolation[] = [];
  for (const scc of sccs) {
    if (scc.length < 2) continue;
    const refs = [...scc];
    const headId = scc[0]!;
    const head = api.neighbours(headId)?.node;
    if (!head?.path) continue;
    violations.push({
      kind: 'cycle',
      severity: scc.length >= 3 ? 'error' : 'warning',
      message: `import cycle (${scc.length} files): ${scc
        .map((id) => api.neighbours(id)?.node?.path ?? id)
        .join(' → ')}`,
      file: head.path,
      suggestedFix:
        'Identify the bidirectional edge and extract the shared types/utilities into a leaf module.',
      refs,
    });
  }
  return violations;
}

function stronglyConnectedComponents(adj: Map<string, string[]>): string[][] {
  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const result: string[][] = [];
  const strongconnect = (v: string): void => {
    indices.set(v, index);
    lowlinks.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!indices.has(w)) {
        strongconnect(w);
        lowlinks.set(v, Math.min(lowlinks.get(v)!, lowlinks.get(w)!));
      } else if (onStack.has(w)) {
        lowlinks.set(v, Math.min(lowlinks.get(v)!, indices.get(w)!));
      }
    }
    if (lowlinks.get(v) === indices.get(v)) {
      const scc: string[] = [];
      while (true) {
        const w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
        if (w === v) break;
      }
      result.push(scc);
    }
  };
  for (const v of adj.keys()) {
    if (!indices.has(v)) strongconnect(v);
  }
  return result;
}

// Re-export so callers can pick up IEdge by symbol from arch-guard.
export type { IEdge };
