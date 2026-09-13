import { selectorUnitFails, type IUnitLiveness } from '@shrkcrft/core';
import type { IAssetDoctorFlags } from './i-asset-doctor-flags.ts';

/**
 * THE proposal of every asset doctor (round 13): `registrations doctor`,
 * `scaffolds doctor`, `search tuning doctor`, `self-config doctor|report`, and
 * MCP `get_scaffold_pattern_doctor` / `get_self_config_doctor` — so a CLI verb
 * and its MCP twin cannot propose different exits over the same report.
 *
 * 1 on an error, on a warning under `--strict`, or on a selector unit THE
 * `--fail-on-dead-units` predicate (`selectorUnitFails`) fails — an unmarked
 * dead unit, or a stale LOCAL `expectEmpty` marker; a pack's stale marker is
 * INFO and never fails the consumer, and an intended-empty unit never fails.
 * Else 0. Settle the proposal against the doctor's coverage (`settleVerdict`):
 * a Coverage-weight dead or unproven unit turns 0 into 2 whatever the flags.
 */
export function assetDoctorProposedExit(
  found: {
    readonly errors: number;
    readonly warnings: number;
    readonly units: readonly Pick<IUnitLiveness, 'state' | 'mark'>[];
  },
  flags: IAssetDoctorFlags,
): 0 | 1 {
  if (found.errors > 0) return 1;
  if (flags.strict && found.warnings > 0) return 1;
  const unitFlags = { failOnDeadUnits: flags.failOnDeadUnits, strict: flags.strict, strictPromotesWarnings: false };
  return found.units.some((u) => selectorUnitFails(u, unitFlags)) ? 1 : 0;
}
