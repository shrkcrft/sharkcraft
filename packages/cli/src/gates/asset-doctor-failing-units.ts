import { selectorUnitFails, type IUnitLiveness } from '@shrkcrft/core';

/**
 * THE selector units that fail an asset doctor's run (round 13 review) — the
 * predicate `assetDoctorProposedExit` proposes its `1` from
 * (`selectorUnitFails`; `--strict` is not the unit promoter on these verbs):
 * an unmarked dead unit under `--fail-on-dead-units`, or a LOCAL marker whose
 * target appeared. A pack marker never fails. `registrations doctor`,
 * `scaffolds doctor`, `search tuning doctor` and `self-config doctor|report`
 * print them (`assetDoctorFailureLine`) and carry them as `failingUnits`, so an
 * exit 1 is never silent about why.
 */
export function assetDoctorFailingUnits(
  units: readonly IUnitLiveness[],
  flags: { readonly failOnDeadUnits: boolean; readonly strict: boolean },
): IUnitLiveness[] {
  return units.filter((u) =>
    selectorUnitFails(u, { failOnDeadUnits: flags.failOnDeadUnits, strict: flags.strict, strictPromotesWarnings: false }),
  );
}
