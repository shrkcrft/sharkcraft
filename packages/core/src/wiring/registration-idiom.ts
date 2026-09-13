import type { IRuleSelfTest, IWiringSource } from './wiring-rule.ts';

/**
 * A declared DI / registration *idiom* — the shape of a runtime-wiring contract
 * that imports can't see. Where a wiring rule asks a single pass/fail question
 * ("is every declared token registered?"), an idiom models the THREE roles a
 * token plays so the registration graph can answer *queries*:
 *
 *   - `declared`  — where a token/provider is DECLARED (an injection token, an
 *     `@Injectable` class, a capability/plugin definition).
 *   - `provided`  — where it is PROVIDED / REGISTERED into a composition (a
 *     `providers: [...]` array, a kernel `register*()` call, a module import).
 *   - `consumed`  — where it is CONSUMED / INJECTED (`@Inject(X)`, a constructor
 *     param, an `inject(X)` call, a `useX()` hook).
 *
 * Each role reuses the wiring {@link IWiringSource} extractor (`{ files, pattern
 * | arrayProperty }`), so the engine never hard-codes a project's identifiers —
 * the idiom shapes are supplied as DATA via `sharkcraft.config.ts
 * registrationGraph[]` (or contributed by a framework pack, same as
 * `wiringRules`). The graph then answers `wiring chain <token>` (declared →
 * provided → consumed, with file:line + direction), `wiring unprovided` (the
 * silent-at-runtime class: declared/injected but never provided), and `wiring
 * orphans` (provided but nothing consumes it).
 */
export interface IRegistrationIdiom {
  /** Stable idiom id, e.g. `di-providers`. */
  readonly name: string;
  /** Human-readable description of the wiring contract this idiom models. */
  readonly description?: string;
  /** Where tokens are DECLARED (capture group 1 / arrayProperty elements = the token). */
  readonly declared: IWiringSource;
  /** Where tokens are PROVIDED / REGISTERED into a composition. */
  readonly provided: IWiringSource;
  /** Where tokens are CONSUMED / INJECTED. */
  readonly consumed: IWiringSource;
  /**
   * Author-declared expectations checked by `shrk gates coverage`.
   *
   * The trust layer asks EVERY data-defined rule to carry one, so a stale glob
   * after a directory move fails loud instead of passing over an empty set. A
   * plane that could not express it was a hole in exactly that contract: its
   * rules were invisible to the stale-selector detector no matter how carefully
   * they were written.
   */
  readonly selfTest?: IRuleSelfTest;
  /**
   * Promote "the DECLARED role extracted 0 tokens" from a loud skip (`2`) to a
   * failure (`1`) in `gates coverage` and `gates check`. Both verbs read the
   * same per-role measurement, so they agree. The declared role is the idiom's
   * primary selector, the set its selfTest asserts on. A provided or consumed
   * role whose globs match no file is not "empty". It is reported as an
   * unexamined role (`partial`, `2`) whether or not this is set. Default
   * `false`, as for a registry, because an idiom carries no severity of its own.
   */
  readonly failOnEmpty?: boolean;
}
