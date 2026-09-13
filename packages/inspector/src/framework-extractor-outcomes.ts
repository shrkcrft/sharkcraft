import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import { importModuleViaLoader, RejectionCause, type IRejectedEntry } from '@shrkcrft/core';
import { frameworkExtractorExports, frameworkExtractorRejectionReasons } from '@shrkcrft/plugin-api';
import type { IContributionFileIssue } from './i-contribution-file-issue.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

/**
 * Every pack `frameworkExtractorFiles` candidate, read through THE shared
 * reading (`frameworkExtractorExports`) and shape predicate
 * (`frameworkExtractorRejectionReasons`, both @shrkcrft/plugin-api) — the
 * same two the runtime loader (`loadPackExtractors`, @shrkcrft/framework-
 * scanners) applies. The inspector cannot import that loader (it sits above
 * this layer via @shrkcrft/graph), so this is how framework extractors join
 * THE rejection channel (round 12, 12.1).
 *
 * A candidate whose `framework` collides with a BUILT-IN extractor (nestjs,
 * react, …) is refused only by the runtime loader, which alone knows the
 * built-in registry; a collision between two contributed extractors is
 * refused here too (the runtime keeps the first).
 */
export async function loadFrameworkExtractorOutcomes(inspection: ISharkcraftInspection): Promise<{
  readonly accepted: readonly { readonly id: string; readonly file: string; readonly packageName: string }[];
  readonly rejected: readonly IRejectedEntry[];
  readonly issues: readonly IContributionFileIssue[];
}> {
  const accepted: { id: string; file: string; packageName: string }[] = [];
  const rejected: IRejectedEntry[] = [];
  const issues: IContributionFileIssue[] = [];
  const seen = new Map<string, string>();
  for (const pack of inspection.packs.validPacks ?? []) {
    const files = (pack.manifest?.contributions as { frameworkExtractorFiles?: readonly string[] } | undefined)
      ?.frameworkExtractorFiles;
    for (const rel of files ?? []) {
      const file = nodePath.resolve(pack.packageRoot, rel);
      if (!existsSync(file)) {
        issues.push({
          severity: 'warning',
          code: 'missing-file',
          message: `Pack ${pack.packageName} declares ${rel} but the file is missing.`,
          source: file,
          packageName: pack.packageName,
        });
        continue;
      }
      let mod: unknown;
      try {
        mod = await importModuleViaLoader(file);
      } catch (e) {
        issues.push({
          severity: 'warning',
          code: 'load-failed',
          message: `Pack ${pack.packageName} (${rel}): ${((e as Error).message ?? String(e)).split('\n')[0]!.trim()}`,
          source: file,
          packageName: pack.packageName,
        });
        continue;
      }
      for (const c of frameworkExtractorExports(mod)) {
        const reasons = frameworkExtractorRejectionReasons(c.value);
        const framework = (c.value as { framework?: unknown } | null)?.framework;
        const at = { file, index: c.index, exportName: c.exportName };
        if (reasons.length > 0) {
          rejected.push({
            ...at,
            ...(typeof framework === 'string' ? { entryId: framework } : {}),
            reasons,
            cause: RejectionCause.Invalid,
          });
          continue;
        }
        const name = framework as string;
        const prev = seen.get(name);
        if (prev !== undefined) {
          rejected.push({
            ...at,
            entryId: name,
            reasons: [`framework: "${name}" is already registered by ${prev}`],
            cause: RejectionCause.DuplicateId,
          });
          continue;
        }
        seen.set(name, `${pack.packageName} (${rel})`);
        accepted.push({ id: name, file, packageName: pack.packageName });
      }
    }
  }
  return { accepted, rejected, issues };
}
