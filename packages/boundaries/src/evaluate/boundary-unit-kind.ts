import { BoundaryMarkableList } from '../model/boundary-markable-list.ts';
import type { IBoundaryDeadUnit } from './evaluate-boundaries.ts';

/**
 * The boundary JSON's `unit` word for a settled unit's list — unchanged since
 * round 11: a `from` negation reports as `exemptFiles`, the exemption it is.
 */
export function boundaryUnitKind(list: string, unit: string): IBoundaryDeadUnit['unit'] {
  if (list === BoundaryMarkableList.From) return unit.startsWith('!') ? 'exemptFiles' : 'from';
  if (list === BoundaryMarkableList.ForbiddenImports) return 'forbidden';
  if (list === BoundaryMarkableList.AllowedImports) return 'allowed';
  return 'exemptFiles';
}
