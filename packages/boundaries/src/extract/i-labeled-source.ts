import type { IWiringSource } from '@shrkcrft/core';

/**
 * One extraction source of a gate rule, named by the side it plays —
 * `declared`, `registered[1]`, `chain[0]`, `source`, `consumer`, a role, or
 * `compute.source`. The label qualifies the source's marker lists
 * (`declared.files`) and prefixes its units in a multi-source report.
 */
export interface ILabeledSource {
  readonly label: string;
  readonly source: IWiringSource;
}
