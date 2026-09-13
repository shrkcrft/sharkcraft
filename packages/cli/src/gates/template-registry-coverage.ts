import type { IVerdictCoverage } from '@shrkcrft/core';

/**
 * THE coverage record of a template-registry verdict: the registered
 * templates, minus any whose operations were never checked (`changes()` threw
 * with sample variables). ZERO registered is an empty request — "nothing to
 * verify", never a pass — unless the caller's `--allow-empty` valve accepts it.
 *
 * `templates doctor` and `check templates` settle on this one record, so the
 * two readers cannot answer "are the templates valid?" two ways over zero
 * templates (round 11 review: the doctor said 2, `check templates` said OK 0).
 */
export function templateRegistryCoverage(input: {
  readonly total: number;
  readonly unchecked?: readonly string[];
  readonly root: string;
  readonly acceptance?: Pick<IVerdictCoverage, 'acceptedBy'>;
}): IVerdictCoverage {
  const unchecked = input.unchecked ?? [];
  return {
    unit: 'templates',
    expected: input.total,
    examined: input.total - unchecked.length,
    root: input.root,
    reason:
      input.total === 0
        ? 'no template is registered'
        : 'changes() threw with sample variables, so their operations were never checked',
    ...(unchecked.length > 0 ? { unexamined: unchecked.slice(0, 20), unexaminedTotal: unchecked.length } : {}),
    ...(input.acceptance ?? {}),
  };
}
