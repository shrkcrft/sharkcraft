import type { IWiringSource } from './wiring-rule.ts';

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
}
