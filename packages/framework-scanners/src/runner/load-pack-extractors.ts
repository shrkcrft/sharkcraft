import * as nodePath from 'node:path';
import { safeImport } from '@shrkcrft/core';
import type { IPackDiscoveryResult } from '@shrkcrft/packs';
import type { IFrameworkExtractor } from '../extractor-api/framework-extractor.ts';
import { FrameworkExtractorRegistry } from '../extractor-api/extractor-registry.ts';

export interface ILoadPackExtractorsResult {
  /** Extractors loaded successfully. */
  extractors: readonly IFrameworkExtractor[];
  /** Free-form messages per skipped / failed pack. */
  diagnostics: readonly string[];
  /** Packs that contributed at least one extractor. */
  packs: readonly string[];
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
  const seenNames = new Set<string>(builtinFrameworkNames);

  for (const pack of discovery.validPacks) {
    const files = pack.manifest?.contributions.frameworkExtractorFiles ?? [];
    if (files.length === 0) continue;
    let contributedCount = 0;
    for (const rel of files) {
      const abs = nodePath.resolve(pack.packageRoot, rel);
      const result = await safeImport<{
        default?: IFrameworkExtractor | readonly IFrameworkExtractor[];
        extractor?: IFrameworkExtractor;
        extractors?: readonly IFrameworkExtractor[];
      }>(abs);
      if (!result.ok) {
        diagnostics.push(`${pack.packageName}:${rel}: load failed (${result.error.message})`);
        continue;
      }
      const fromDefault = result.module.default;
      const candidates: IFrameworkExtractor[] = [];
      if (Array.isArray(fromDefault)) {
        candidates.push(...(fromDefault as readonly IFrameworkExtractor[]));
      } else if (fromDefault && typeof fromDefault === 'object') {
        candidates.push(fromDefault as IFrameworkExtractor);
      }
      if (result.module.extractor) candidates.push(result.module.extractor);
      if (Array.isArray(result.module.extractors)) candidates.push(...result.module.extractors);
      if (candidates.length === 0) {
        diagnostics.push(`${pack.packageName}:${rel}: no extractor exports found`);
        continue;
      }
      for (const ex of candidates) {
        if (!ex || typeof ex !== 'object' || typeof ex.framework !== 'string' || typeof ex.fileMatches !== 'function' || typeof ex.extract !== 'function') {
          diagnostics.push(`${pack.packageName}:${rel}: invalid extractor shape (missing framework / fileMatches / extract)`);
          continue;
        }
        if (seenNames.has(ex.framework)) {
          diagnostics.push(
            `${pack.packageName}:${rel}: framework "${ex.framework}" already registered — skipping`,
          );
          continue;
        }
        seenNames.add(ex.framework);
        extractors.push(ex);
        contributedCount += 1;
      }
    }
    if (contributedCount > 0) packs.push(pack.packageName);
  }
  return { extractors, diagnostics, packs };
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
  for (const ex of loaded.extractors) {
    // `registry.register` throws on collision — we've already filtered
    // duplicates above. Use a try/catch just in case.
    try {
      defaultRegistry.register(ex);
    } catch (e) {
      loaded.diagnostics.concat(`${ex.framework}: register failed (${(e as Error).message})`);
    }
  }
  return { registry: defaultRegistry, diagnostics: loaded.diagnostics, packs: loaded.packs };
}
