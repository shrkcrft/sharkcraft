import { EdgeKind, type GraphQueryApi, type IEdge, type INode } from '@shrkcrft/graph';
import type { IArchViolation } from '../schema/violation.ts';

/**
 * Detect cross-package imports that reach past the public entrypoint.
 *
 * Heuristic:
 *   - Allowed: importing from `<pkg>` (resolved to `<pkg>/src/index.ts`).
 *   - Allowed: importing a same-package sibling via relative path.
 *   - Violation: cross-package import whose resolved target is NOT an
 *     `index.ts` or `*.d.ts` (i.e. it reaches a private internal file).
 *
 * Detected via the `imports-file` edge in the code graph + the file
 * node's owning package (via `belongs-to-package` edges).
 */
export function detectPublicApiMisuse(api: GraphQueryApi): readonly IArchViolation[] {
  const out: IArchViolation[] = [];
  const fileByIdPackage = buildFileToPackageMap(api);

  for (const file of api.allFiles()) {
    const neighbours = api.neighbours(file.id);
    if (!neighbours) continue;
    const fromPkg = fileByIdPackage.get(file.id);
    if (!fromPkg) continue;
    for (const o of neighbours.out) {
      if (o.edge.kind !== EdgeKind.ImportsFile) continue;
      const targetId = o.edge.to;
      if (!targetId.startsWith('file:')) continue; // external / unresolved
      const target = api.neighbours(targetId)?.node;
      if (!target?.path) continue;
      const toPkg = fileByIdPackage.get(targetId);
      if (!toPkg || toPkg === fromPkg) continue;
      // Cross-package import — confirm it lands on a public entry.
      const path = target.path;
      const isPublic =
        /\/index\.[mc]?[jt]sx?$/.test(path) ||
        path.endsWith('.d.ts') ||
        path.endsWith('.d.cts') ||
        path.endsWith('.d.mts');
      if (isPublic) continue;
      out.push({
        kind: 'public-api-misuse',
        severity: 'error',
        message: `cross-package import of private file: ${fromPkg} → ${toPkg} (${target.path})`,
        file: file.path!,
        line: (o.edge.data?.['line'] as number | undefined) ?? undefined,
        targetFile: target.path,
        suggestedFix: `import from the package entry point (${toPkg}) instead of the internal file.`,
        refs: [file.id, target.id],
      });
    }
  }
  return out;
}

function buildFileToPackageMap(api: GraphQueryApi): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of api.allFiles()) {
    const neighbours = api.neighbours(file.id);
    if (!neighbours) continue;
    for (const o of neighbours.out) {
      if (o.edge.kind !== EdgeKind.BelongsToPackage) continue;
      const target = o.target as INode | { id: string; resolved: false };
      if ('resolved' in target) continue;
      out.set(file.id, target.label);
      break;
    }
  }
  return out;
}

// Re-export so types unused by callers don't trigger noUnusedImports.
export type { IEdge };
