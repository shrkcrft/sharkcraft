import { EdgeKind, type GraphQueryApi } from '@shrkcrft/graph';
import type { IArchViolation } from '../schema/violation.ts';

const FAT_BARREL_THRESHOLD = 40;

/**
 * Detect risky barrel files (`index.ts` re-exporters):
 *
 *   - barrel-fat: > 40 re-exports without grouping commentary.
 *   - barrel-cycle: barrel re-exports a module that transitively imports
 *     the barrel itself (creates an import cycle through the barrel).
 *
 * Both checks are intentionally low-noise: only barrels named `index.ts`
 * (or `.tsx` / `.js`) are considered.
 */
export function detectBarrelRisks(api: GraphQueryApi): readonly IArchViolation[] {
  const out: IArchViolation[] = [];
  for (const file of api.allFiles()) {
    if (!file.path || !/(?:^|\/)index\.[mc]?[jt]sx?$/.test(file.path)) continue;
    const data = file.data ?? {};
    const reExportCount = (data['reExportCount'] as number | undefined) ?? 0;
    const exportCount = (data['exportCount'] as number | undefined) ?? 0;
    if (reExportCount + exportCount >= FAT_BARREL_THRESHOLD) {
      out.push({
        kind: 'barrel-fat',
        severity: 'warning',
        message: `fat barrel: ${reExportCount + exportCount} (re-)exports in a single index file`,
        file: file.path,
        suggestedFix: 'Split into themed sub-barrels (e.g. `./model`, `./service`) and re-export those.',
        refs: [file.id],
      });
    }
    // Cycle through this barrel: does any file the barrel imports
    // (directly or transitively, capped 1-hop here) also import the
    // barrel back?
    const neighbours = api.neighbours(file.id);
    if (!neighbours) continue;
    const importedTargets = neighbours.out
      .filter((o) => o.edge.kind === EdgeKind.ImportsFile)
      .map((o) => o.edge.to);
    for (const tgt of importedTargets) {
      const reverse = api.neighbours(tgt);
      if (!reverse) continue;
      const reExportsBarrel = reverse.out.some(
        (o) => o.edge.kind === EdgeKind.ImportsFile && o.edge.to === file.id,
      );
      if (reExportsBarrel) {
        const tNode = api.neighbours(tgt)?.node;
        out.push({
          kind: 'barrel-cycle',
          severity: 'error',
          message: `barrel cycle: ${file.path} re-exports a module that imports the barrel back`,
          file: file.path,
          targetFile: tNode?.path,
          suggestedFix:
            'Move the cycle-creating module out of the barrel, or import directly from the leaf file.',
          refs: [file.id, tgt],
        });
      }
    }
  }
  return out;
}
