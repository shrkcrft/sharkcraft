import type { StructuralPattern } from './pattern.ts';

export const STRUCTURAL_REWRITE_SCHEMA = 'sharkcraft.structural-rewrite-plan/v1' as const;

/**
 * A rewrite recipe describes what to do at each pattern match.
 *
 * Recipes are intentionally narrow — each one targets one shape of
 * match. Mixing kinds in a single rewrite is not supported; run two
 * passes instead.
 *
 * Supported recipes (Wave 8 foundation):
 *
 *   - `replace-identifier-name` — given an `Identifier` pattern,
 *     replace the matched identifier's text with `to`.
 *   - `replace-call-callee` — given a `CallExpression` pattern,
 *     replace the callee identifier text with `to`. Useful for
 *     `console.log(...)` → `logger.info(...)`.
 *   - `replace-import-from` — given an `ImportDeclaration` pattern,
 *     replace the module specifier string with `to`. Useful for
 *     `from 'lodash'` → `from 'lodash-es'`.
 */
export type RewriteRecipe =
  | { kind: 'replace-identifier-name'; to: string }
  | { kind: 'replace-call-callee'; to: string }
  | { kind: 'replace-import-from'; to: string };

export interface IEdit {
  /** Character offset (inclusive) where the edit starts. */
  start: number;
  /** Character offset (exclusive) where the edit ends. */
  end: number;
  /** New text. */
  replacement: string;
  /** Old text. Provided for human review. */
  before: string;
  /** 1-based line number for display. */
  line: number;
}

export interface IFileEdits {
  /** Project-relative POSIX path. */
  path: string;
  /** Edits sorted by `start` ascending. */
  edits: readonly IEdit[];
}

export interface IRewritePlan {
  schema: typeof STRUCTURAL_REWRITE_SCHEMA;
  pattern: StructuralPattern;
  recipe: RewriteRecipe;
  filesScanned: number;
  totalEdits: number;
  files: readonly IFileEdits[];
  diagnostics: readonly string[];
}
