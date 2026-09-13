import type { IUnitMark } from './i-unit-mark.ts';

/** A normalised boost map: the plain `key → weight` map every reader consumes, plus the marker ledger. */
export interface IUnitMap {
  /** A marked value contributes its `weight`; the map never holds an object. */
  readonly values: Readonly<Record<string, number>>;
  /** One mark per marked key. */
  readonly marks: readonly IUnitMark[];
}
