import { globToRegex } from '@shrkcrft/boundaries';
import { EdgeKind, type GraphQueryApi } from '@shrkcrft/graph';
import type { IArchContract } from '../schema/contract.ts';
import type { IArchViolation } from '../schema/violation.ts';

interface ICompiledLayer {
  name: string;
  matchers: readonly RegExp[];
}

/**
 * Evaluate a project-specific architecture contract against the graph.
 *
 * For each `imports-file` edge whose source file matches a layer:
 *   - If the source's rule has `mayNotImport` and the target layer is in
 *     that list → violation.
 *   - If the source's rule has `mayImport` (a positive whitelist) and
 *     the target layer is NOT in that list → violation.
 *
 * Files that match no layer are ignored (the contract says nothing
 * about them). External / unresolved imports are skipped.
 */
export function evaluateContract(
  api: GraphQueryApi,
  contract: IArchContract,
): readonly IArchViolation[] {
  const compiled = compile(contract);
  const out: IArchViolation[] = [];
  for (const file of api.allFiles()) {
    if (!file.path) continue;
    const srcLayer = matchLayer(file.path, compiled);
    if (!srcLayer) continue;
    const rule = contract.rules.find((r) => r.from === srcLayer);
    if (!rule) continue;
    const neighbours = api.neighbours(file.id);
    if (!neighbours) continue;
    for (const o of neighbours.out) {
      if (o.edge.kind !== EdgeKind.ImportsFile) continue;
      const target = api.neighbours(o.edge.to)?.node;
      if (!target?.path) continue;
      const tgtLayer = matchLayer(target.path, compiled);
      if (!tgtLayer) continue;
      if (rule.mayNotImport?.includes(tgtLayer)) {
        out.push({
          kind: 'contract-import',
          severity: rule.severity ?? 'error',
          message: `contract violation: ${srcLayer} → ${tgtLayer} (forbidden by ${contract.id ?? 'arch-contract'})`,
          file: file.path,
          line: (o.edge.data?.['line'] as number | undefined) ?? undefined,
          targetFile: target.path,
          suggestedFix: rule.reason ?? `Refactor so the dependency goes the other way (${tgtLayer} → ${srcLayer}).`,
          refs: [file.id, target.id],
        });
        continue;
      }
      if (rule.mayImport && rule.mayImport.length > 0 && !rule.mayImport.includes(tgtLayer)) {
        out.push({
          kind: 'contract-layer-skip',
          severity: rule.severity ?? 'error',
          message: `contract violation: ${srcLayer} may only import {${rule.mayImport.join(', ')}}, found → ${tgtLayer}`,
          file: file.path,
          line: (o.edge.data?.['line'] as number | undefined) ?? undefined,
          targetFile: target.path,
          suggestedFix: rule.reason,
          refs: [file.id, target.id],
        });
      }
    }
  }
  return out;
}

function compile(c: IArchContract): readonly ICompiledLayer[] {
  return c.layers.map((l) => ({
    name: l.name,
    matchers: l.includes.map((p) => globToRegex(p)),
  }));
}

function matchLayer(path: string, layers: readonly ICompiledLayer[]): string | undefined {
  for (const l of layers) {
    if (l.matchers.some((re) => re.test(path))) return l.name;
  }
  return undefined;
}
