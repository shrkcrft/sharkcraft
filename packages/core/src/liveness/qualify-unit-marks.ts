import type { IUnitMark } from './i-unit-mark.ts';
import { qualifyListPath } from './qualify-list-path.ts';

/**
 * A ledger with every `list` qualified by `qualifier` (`qualifyListPath`) — for
 * a settle that spans several owners: a wiring rule's `declared` / `registered`
 * sources, or every hint of a doctor run. Pair it with observations whose
 * `list` is qualified the same way.
 */
export function qualifyUnitMarks(marks: readonly IUnitMark[], qualifier: string): readonly IUnitMark[] {
  return marks.map((m) => ({ ...m, list: qualifyListPath(qualifier, m.list) }));
}
