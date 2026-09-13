import { DEAD_SELECTOR_CAUSES } from './dead-selector-causes.ts';
import type { IFormatUnitLivenessOptions } from './i-format-unit-liveness-options.ts';
import type { IUnitLiveness } from './i-unit-liveness.ts';
import { UnitLivenessState } from './unit-liveness-state.ts';

/**
 * THE per-unit line every surface prints — `<label> — <state sentence>`:
 *
 *   @scope/plugin-react — matches no import … and no file — typo, retired target, or a target that does not exist yet (see expectEmpty)
 *   @scope/plugin-react — intended empty (expectEmpty: planned binding) — matches no import …
 *   @scope/plugin-react — expectEmpty is stale: 2 import(s) — the fence went live; remove expectEmpty
 *
 * A surface adds only its own decoration (a bullet, `[forbidden] <ruleId>:`),
 * never its own words for a state. Live units have a line too (JSON), though
 * text surfaces do not print them.
 */
export function formatUnitLiveness(unit: IUnitLiveness, options: IFormatUnitLivenessOptions = {}): string {
  const prefix = options.list === true && unit.label === unit.unit ? `${unit.list}: ` : '';
  const causes =
    (options.causes ?? true) && unit.state === UnitLivenessState.Dead && unit.cause === undefined
      ? ` — ${DEAD_SELECTOR_CAUSES}`
      : '';
  return `${prefix}${unit.label} — ${unit.message}${causes}`;
}
