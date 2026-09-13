import type { IUnitMark } from './i-unit-mark.ts';

/** A normalised selector list: the plain units every reader consumes, plus the marker ledger. */
export interface IUnitList {
  /** The plain units, in authored order — exactly what a string reader consumes (duplicates kept). */
  readonly units: readonly string[];
  /** One mark per MARKED unit (a unit may be marked once per list). */
  readonly marks: readonly IUnitMark[];
}
