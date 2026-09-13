import type { IUnitMark } from './i-unit-mark.ts';

/** A normalised scalar selector (`discovery.targetFile`): the plain unit, plus its mark when marked. */
export interface IUnitScalar {
  readonly unit: string;
  /** Empty, or the one mark of a marked scalar — the same ledger shape a list produces. */
  readonly marks: readonly IUnitMark[];
}
