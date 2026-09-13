import type { UnitLivenessState } from '@shrkcrft/core';
import type { IBoundaryDeadUnit } from './evaluate-boundaries.ts';

/**
 * One settled selector unit of a boundary rule, as every boundary surface
 * reports it (round 13): `check boundaries` text and `--json` (`intendedEmpty`,
 * `wentLive`, `failingUnits`), MCP `check_boundaries`, the quality and finish
 * notes. Built by `boundaryUnitFinding` from the one settle.
 */
export interface IBoundaryUnitFinding {
  readonly ruleId: string;
  /** The boundary JSON's unit word: `from`, `forbidden`, `allowed` or `exemptFiles`. */
  readonly unit: IBoundaryDeadUnit['unit'];
  readonly selector: string;
  readonly state: UnitLivenessState;
  /** THE sentence for the unit (`formatUnitLiveness`), without the selector the row already names. */
  readonly reason: string;
  /** The marker's own reason, when the unit is marked `expectEmpty`. */
  readonly markReason?: string;
  /** The pack that stamped the marker: a pack marker that went live is INFO and never fails the run. */
  readonly packageName?: string;
}
