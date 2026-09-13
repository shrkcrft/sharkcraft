import type { SelectorListEntry } from '../liveness/selector-list-entry.ts';
import type { IImportEdgeTargetInput } from './i-import-edge-target-input.ts';
import type { IWiringSource } from './wiring-rule.ts';

/**
 * The AUTHORED extraction source (round 13): {@link IWiringSource} with its
 * markable lists widened — `files` and `to.files` take a glob or `{ pattern,
 * expectEmpty: true, reason? }`. The loaded shape keeps plain string lists and
 * carries the markers in `expectEmptyUnits` (`normalizeWiringSource`), which an
 * author can never write.
 */
export interface IWiringSourceInput extends Omit<IWiringSource, 'files' | 'to' | 'expectEmptyUnits'> {
  readonly files?: readonly SelectorListEntry[];
  readonly to?: IImportEdgeTargetInput;
}
