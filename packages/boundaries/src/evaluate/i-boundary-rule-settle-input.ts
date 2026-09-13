import type { IUnitObservation } from '@shrkcrft/core';
import type { IBoundaryRule } from '../model/boundary-rule.ts';

/** What `settleBoundaryRule` needs: one rule's selector-unit observations and the counts its emptiness is decided from. */
export interface IBoundaryRuleSettleInput {
  readonly rule: Pick<IBoundaryRule, 'id' | 'severity' | 'failOnEmpty' | 'expectEmptyUnits'>;
  /**
   * One per judged unit: `from` inclusions (Coverage weight), `from` negations
   * and `exemptFiles`, `forbiddenImports`, `allowedImports` (Advisory). The
   * `list` of each is its `BoundaryMarkableList` value — the list its marks carry.
   */
  readonly observations: readonly IUnitObservation[];
  /** The rule's `from` inclusion globs — named when the rule matched no file. */
  readonly includeGlobs: readonly string[];
  /** Scanned files the scopes were counted against. */
  readonly filesScanned: number;
  /** Where that file list came from (`edges`: a hand-built scan without a file list). */
  readonly fileUniverse: 'scan' | 'edges';
  /** Governed files: inside `from`, not exempt. */
  readonly filesInScope: number;
  /** Inside `from` but exempt. */
  readonly exemptFilesInScope: number;
  /** The rule's unsuppressed violations. */
  readonly violations: number;
  /** A governed file in the rule's scope could not be read: the rule is partial, never "matched nothing". */
  readonly unread: boolean;
}
