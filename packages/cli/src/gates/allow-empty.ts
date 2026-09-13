import type { IVerdictCoverage } from '@shrkcrft/core';
import { flagBool, type ParsedArgs } from '../command-registry.ts';

/** The shared flag name — one spelling across every verdict verb. */
export const ALLOW_EMPTY_FLAG = 'allow-empty';

/**
 * The `--allow-empty` valve, defined once for every verdict verb.
 *
 * "Nothing to examine" is not a pass — a verb whose request covered zero units
 * (no rules declared, nothing in the changeset, nothing deleted) exits `2`. A
 * hook that runs on every commit legitimately hits that state, so it may accept
 * it EXPLICITLY. Spread the result into the verb's RUN coverage:
 *
 * ```ts
 * buildGateEnvelope(verb, proposed, rules, { unit: 'rules', expected, examined, ...allowEmptyValve(args, expected) })
 * ```
 *
 * It sets `acceptedBy: '--allow-empty'` ONLY when the flag was passed AND the
 * request covered nothing (`expected === 0`). It never accepts a partial scope —
 * rules that exist but checked nothing are a stale selector, not an empty
 * request — and the acceptance is printed by `verdictLine`, never silent.
 * Declare the flag in the verb's `booleanFlags` so it never swallows a
 * following positional.
 */
export function allowEmptyValve(
  args: ParsedArgs,
  expected: number,
): Pick<IVerdictCoverage, 'acceptedBy'> {
  return flagBool(args, ALLOW_EMPTY_FLAG) && expected === 0
    ? { acceptedBy: `--${ALLOW_EMPTY_FLAG}` }
    : {};
}
