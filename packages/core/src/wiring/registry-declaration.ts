import type { IWiringSource } from './wiring-rule.ts';

/**
 * A declared "registry inventory" — a string-keyed set of contributions a
 * project spreads across several files (built-ins + per-module contributions +
 * extension packs). Reuses the wiring `IWiringSource` extractor (`{ files,
 * pattern | arrayProperty }`) to harvest the registry's ids, so the engine
 * never hard-codes a project-specific identifier.
 *
 * Surfaced via `shrk registry <name> list | exists <id> | where <id>` — one
 * deterministic, alias-blind, multi-root scan that answers "is this id already
 * taken / where is it declared / what binds it" without an agent re-running a
 * fragile multi-root grep.
 *
 * Projects supply declarations as data via `sharkcraft.config.ts`
 * `registries[]`. The engine is source-agnostic, so a pack could contribute a
 * declaration the same way it contributes wiring rules.
 */
export interface IRegistryDeclaration {
  /** Stable registry id, e.g. `commands` — the name used on the CLI. */
  readonly name: string;
  /** Human-readable description of what the registry holds. */
  readonly description?: string;
  /**
   * Where the registry's ids are declared/registered, and how to extract them
   * (capture-group-1 of `pattern`, or the elements of `arrayProperty`).
   */
  readonly source: IWiringSource;
  /**
   * Optional: where each id is consumed/bound (a renderer, dispatcher, or
   * allowlist). Surfaced by `where <id>` so a consumer can see both the
   * declaration and the binding site.
   */
  readonly consumer?: IWiringSource;
  /**
   * Optional human-noun → canonical-id map. The noun an author types is not
   * always the exact registered slug; `exists <id> --resolve` maps it to the
   * canonical id before the existence test, so a "is this taken?" check can't
   * miss on a synonym of an already-registered id. Keys are the aliases, values
   * the canonical ids.
   */
  readonly aliases?: Readonly<Record<string, string>>;
}
