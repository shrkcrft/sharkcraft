import type { IUnresolvableReference } from './i-unresolvable-reference.ts';

/**
 * What the self-config doctor's REFERENCE probes examined (round 12,
 * ONE-CHANGE): every declared reference id they probed (`expected`), how many
 * could be checked (`examined`), and each one that could not. The same probes
 * the doctor reports — `collectUnresolvableReferences` runs them, and
 * `buildSelfConfigDoctorReportV2` carries the same list.
 */
export interface IUnresolvableReferenceScan {
  readonly expected: number;
  readonly examined: number;
  readonly references: readonly IUnresolvableReference[];
}
