/**
 * Reuse primitives — the "use the existing thing" plane.
 *
 * The single most-violated rule in many large codebases is "reuse the canonical
 * primitive instead of re-implementing it." An agent told to discover the
 * primitive by `grep` / reading a barrel file structurally cannot: the symbol
 * name it needs isn't in the barrel text (a barrel is `export *`), and deep
 * utilities sit many levels down, ungreppable.
 *
 * `shrk reuse <intent>` closes that gap. A project declares its canonical
 * primitives as data via `sharkcraft.config.ts` `reusePrimitives[]`, keyed by
 * role/intent. The command matches the intent to a primitive, then uses the
 * code graph to resolve the symbol to its real declaration, its sibling
 * exports, and real consumer files to copy. For the public import path it uses
 * the configured `importPath`; if omitted, it surfaces a re-exporting barrel as
 * a hint (it never fabricates a module specifier from a deep file path).
 *
 * The registry is generic — no project specifics live in shrk. No AI.
 */

export interface IReusePrimitive {
  /** The canonical exported symbol to reuse (e.g. `Button`, `useDebounce`). */
  readonly symbol: string;
  /**
   * Role / intent labels this primitive satisfies. `shrk reuse "<intent>"`
   * matches the query tokens against these (plus `keywords`, `symbol`,
   * `description`). e.g. `['text input', 'form control']`.
   */
  readonly roles: readonly string[];
  /**
   * The public import specifier consumers should import the symbol FROM
   * (the barrel/package entry, e.g. `@scope/ui`). Strongly recommended: it is
   * the only source of a copy-pasteable import line. When omitted, `shrk reuse`
   * shows the declaration site and a re-exporting barrel hint instead.
   */
  readonly importPath?: string;
  /** One-line description of when to reach for this primitive. */
  readonly description?: string;
  /** Extra free-text keywords to widen intent matching. */
  readonly keywords?: readonly string[];
}
