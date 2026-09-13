import type { IUnitLiveness } from '@shrkcrft/core';

/**
 * One rule's settled selector units, as a plane verb hands them to THE shared
 * unit-state renderer (`unitStateNotes`): the rule id it prints them under and
 * the rule's non-live units (`unitLiveness` on every plane engine's result).
 */
export interface IUnitStateNoteRow {
  readonly id: string;
  readonly unitLiveness?: readonly IUnitLiveness[];
  /**
   * The rule is already reported as matching nothing (skipped / failed empty):
   * its dead units are that verdict, never a second advisory line.
   */
  readonly reportedEmpty?: boolean;
}
