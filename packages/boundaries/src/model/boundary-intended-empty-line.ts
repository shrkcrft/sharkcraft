import type { IUnitMark } from '@shrkcrft/core';

/**
 * THE line `boundaries explain` and MCP `get_boundary_rule` print for one
 * `expectEmpty` marker of a rule (round 13), next to its redundant and shadowed
 * notes: `<list> <unit> — <reason>` (+ the stamped pack). It states the
 * assertion only — whether the target has appeared since (went live) is a
 * run-time fact, which `shrk check boundaries` reports.
 */
export function boundaryIntendedEmptyLine(mark: IUnitMark): string {
  const pack = mark.packageName !== undefined ? ` [marker from pack ${mark.packageName}]` : '';
  return `${mark.list} ${mark.unit} — ${mark.reason ?? 'no reason given'}${pack}`;
}
