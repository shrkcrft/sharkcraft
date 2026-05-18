/**
 * Built-in extractor registry.
 *
 * Two extractors, no plugin-api surface. Pack-contributed extractors
 * are explicitly out of scope for now — revisit when a real pack
 * needs one.
 */

import {
  MARKDOWN_FRONTMATTER_LOOSE_EXTRACTOR_ID,
  markdownFrontmatterLooseExtractor,
} from './extractors/markdown-frontmatter-loose.ts';
import {
  SHARKCRAFT_SPEC_V1_EXTRACTOR_ID,
  sharkcraftSpecV1Extractor,
} from './extractors/sharkcraft-spec-v1.ts';
import type { IPlanExtractor } from './extractor.ts';

export const BUILTIN_EXTRACTORS: readonly IPlanExtractor[] = Object.freeze([
  sharkcraftSpecV1Extractor,
  markdownFrontmatterLooseExtractor,
]);

export function getExtractorById(id: string): IPlanExtractor | null {
  return BUILTIN_EXTRACTORS.find((e) => e.id === id) ?? null;
}

/**
 * Pick the highest-confidence extractor for a path. Order:
 *   1. The first extractor whose `accepts(path)` returns true,
 *      preferring `sharkcraft.spec/v1` over `markdown-frontmatter-loose`.
 *   2. Otherwise, null — caller must pick explicitly.
 */
export function pickExtractor(path: string): IPlanExtractor | null {
  for (const e of BUILTIN_EXTRACTORS) {
    if (e.accepts(path)) return e;
  }
  return null;
}

export {
  MARKDOWN_FRONTMATTER_LOOSE_EXTRACTOR_ID,
  SHARKCRAFT_SPEC_V1_EXTRACTOR_ID,
};
