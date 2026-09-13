import type { SelectorListEntry } from '../liveness/selector-list-entry.ts';
import type { IImportEdgeTarget } from './wiring-rule.ts';

/**
 * The AUTHORED `import-edges` target (round 13): {@link IImportEdgeTarget}
 * with a markable `files` list — a glob, or `{ pattern, expectEmpty: true,
 * reason? }` for a fence target that does not exist yet. The loader normalises
 * it into the plain string list the engine reads plus the source's
 * `expectEmptyUnits` (`list: 'to.files'`).
 */
export interface IImportEdgeTargetInput extends Omit<IImportEdgeTarget, 'files'> {
  readonly files?: readonly SelectorListEntry[];
}
