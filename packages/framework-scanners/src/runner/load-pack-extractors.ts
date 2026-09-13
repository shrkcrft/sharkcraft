import * as nodePath from 'node:path';
import { RejectionCause, safeImport, type IRejectedEntry } from '@shrkcrft/core';
import type { IPackDiscoveryResult } from '@shrkcrft/packs';
import { frameworkExtractorExports, frameworkExtractorRejectionReasons } from '@shrkcrft/plugin-api';
import type { IFrameworkExtractor } from '../extractor-api/framework-extractor.ts';
import { FrameworkExtractorRegistry } from '../extractor-api/extractor-registry.ts';

export interface ILoadPackExtractorsResult {
  /** Extractors loaded successfully. */
  extractors: readonly IFrameworkExtractor[];
  /** Free-form messages per skipped / failed pack. */
  diagnostics: readonly string[];
  /** Packs that contributed at least one extractor. */
  packs: readonly string[];
  /**
   * Every contributed extractor the loader refused — an invalid shape, or a
   * `framework` name a built-in or earlier extractor already registered —
   * with its position and every reason (round 12, 12.1).
   */
  rejected: readonly IRejectedEntry[];
}

/**
 * Walk the pack discovery result and load any
 * `contributions.frameworkExtractorFiles` declared by valid packs.
 *
 * Errors per pack become diagnostics — never propagated. Framework
 * name collisions with built-in extractors (or with each other) are
 * also diagnostics; the colliding contribution is skipped. Built-in
 * extractors always win — packs may not shadow them.
 *
 * The candidates and their shape check are THE shared reading
 * (`frameworkExtractorExports` / `frameworkExtractorRejectionReasons`,
 * @shrkcrft/plugin-api) the inspector's rejection channel applies too.
 *
 * Pure: this loader does NOT mutate any registry on its own. The
 * caller decides what to do with the returned extractors (typically
 * `registry.register(ex)` against a `defaultRegistry()`).
 */
export async function loadPackExtractors(
  discovery: IPackDiscoveryResult,
  builtinFrameworkNames: ReadonlySet<string>,
): Promise<ILoadPackExtractorsResult> {
  const extractors: IFrameworkExtractor[] = [];
  const diagnostics: string[] = [];
  const packs: string[] = [];
  const rejected: IRejectedEntry[] = [];
  const seenNames = new Set<string>(builtinFrameworkNames);

  for (const pack of discovery.validPacks) {
    const files = pack.manifest?.contributions.frameworkExtractorFiles ?? [];
    if (files.length === 0) continue;
    let contributedCount = 0;
    for (const rel of files) {
      const abs = nodePath.resolve(pack.packageRoot, rel);
      const result = await safeImport<Record<string, unknown>>(abs);
      if (!result.ok) {
        diagnostics.push(`${pack.packageName}:${rel}: load failed (${result.error.message})`);
        continue;
      }
      const candidates = frameworkExtractorExports(result.module);
      if (candidates.length === 0) {
        diagnostics.push(`${pack.packageName}:${rel}: no extractor exports found`);
        continue;
      }
      for (const c of candidates) {
        const reasons = frameworkExtractorRejectionReasons(c.value);
        const name = (c.value as { framework?: unknown } | null)?.framework;
        const at = { file: abs, index: c.index, exportName: c.exportName };
        if (reasons.length > 0) {
          diagnostics.push(`${pack.packageName}:${rel}: invalid extractor shape (missing framework / fileMatches / extract)`);
          rejected.push({
            ...at,
            ...(typeof name === 'string' ? { entryId: name } : {}),
            reasons,
            cause: RejectionCause.Invalid,
          });
          continue;
        }
        const ex = c.value as IFrameworkExtractor;
        if (seenNames.has(ex.framework)) {
          diagnostics.push(
            `${pack.packageName}:${rel}: framework "${ex.framework}" already registered — skipping`,
          );
          rejected.push({
            ...at,
            entryId: ex.framework,
            reasons: [
              `framework: "${ex.framework}" is already registered${
                builtinFrameworkNames.has(ex.framework) ? ' by a built-in extractor' : ''
              }`,
            ],
            cause: RejectionCause.DuplicateId,
          });
          continue;
        }
        seenNames.add(ex.framework);
        extractors.push(ex);
        contributedCount += 1;
      }
    }
    if (contributedCount > 0) packs.push(pack.packageName);
  }
  return { extractors, diagnostics, packs, rejected };
}

/**
 * Convenience: build a `FrameworkExtractorRegistry` pre-populated with
 * the built-ins AND with pack-contributed extractors. Diagnostics are
 * available for surfacing in CLI / MCP output via the returned tuple.
 */
export async function buildRegistryWithPacks(
  defaultRegistry: FrameworkExtractorRegistry,
  discovery: IPackDiscoveryResult,
): Promise<{ registry: FrameworkExtractorRegistry; diagnostics: readonly string[]; packs: readonly string[] }> {
  const builtinNames = new Set(defaultRegistry.list().map((e) => e.framework));
  const loaded = await loadPackExtractors(discovery, builtinNames);
  const diagnostics = [...loaded.diagnostics];
  for (const ex of loaded.extractors) {
    // `registry.register` throws on a collision. The loader filtered duplicates
    // against the registry as it stood when this call began, but the registry
    // is shared — a concurrent caller may have registered the same framework
    // since. Record it: a loader never drops an entry silently (round 13 — the
    // old `diagnostics.concat(...)` discarded its result, so nothing was kept).
    try {
      defaultRegistry.register(ex);
    } catch (e) {
      diagnostics.push(`${ex.framework}: register failed (${(e as Error).message})`);
    }
  }
  return { registry: defaultRegistry, diagnostics, packs: loaded.packs };
}
