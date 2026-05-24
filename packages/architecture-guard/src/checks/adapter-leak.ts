import { EdgeKind, type GraphQueryApi } from '@shrkcrft/graph';
import type { IArchViolation } from '../schema/violation.ts';

/**
 * Layer-skip patterns the check looks for by default. Each entry says
 * "a file matching `from` should NOT directly import a file matching
 * `to` — go through `via` instead."
 *
 * The defaults catch the most common backend layering anti-patterns
 * (NestJS / Express-shaped apps + simple domain layering). Teams that
 * want different rules use the contract DSL (`sharkcraft/arch.ts`).
 */
const DEFAULT_PATTERNS: ReadonlyArray<{
  from: RegExp;
  to: RegExp;
  via: string;
  message: string;
}> = [
  {
    from: /\.(controller|controllers)\.[tj]sx?$/,
    to: /\.(repository|repositories|repo)\.[tj]sx?$/,
    via: 'service layer',
    message: 'controller imports repository directly — route through a service.',
  },
  {
    from: /\.(controller|controllers)\.[tj]sx?$/,
    to: /\.(entity|entities|model|models)\.[tj]sx?$/,
    via: 'service or DTO layer',
    message: 'controller imports an entity / persistence model — route through a service or DTO.',
  },
  {
    from: /\.(view|page|component)\.[tj]sx?$/,
    to: /\.(repository|repositories|repo)\.[tj]sx?$/,
    via: 'service / hook layer',
    message: 'UI component imports repository directly — go through a service / hook.',
  },
];

/**
 * Detect layer-skip imports: a file in one architectural role importing
 * a file in a role that should be reached only via an intermediate
 * layer.
 *
 * Heuristic only — names like `*.controller.ts` are the signal. Teams
 * with non-conventional names should use the contract DSL instead.
 */
export function detectAdapterLeaks(api: GraphQueryApi): readonly IArchViolation[] {
  const out: IArchViolation[] = [];
  for (const file of api.allFiles()) {
    if (!file.path) continue;
    const fromPath = file.path.toLowerCase();
    const matchingPatterns = DEFAULT_PATTERNS.filter((p) => p.from.test(fromPath));
    if (matchingPatterns.length === 0) continue;
    const neighbours = api.neighbours(file.id);
    if (!neighbours) continue;
    for (const o of neighbours.out) {
      if (o.edge.kind !== EdgeKind.ImportsFile) continue;
      const target = api.neighbours(o.edge.to)?.node;
      if (!target?.path) continue;
      const toPath = target.path.toLowerCase();
      for (const p of matchingPatterns) {
        if (!p.to.test(toPath)) continue;
        out.push({
          kind: 'public-api-misuse',
          severity: 'warning',
          message: `adapter leak: ${file.path} → ${target.path} — ${p.message}`,
          file: file.path,
          line: (o.edge.data?.['line'] as number | undefined) ?? undefined,
          targetFile: target.path,
          suggestedFix: `Introduce the ${p.via} between these two files.`,
          refs: [file.id, target.id],
        });
      }
    }
  }
  return out;
}
