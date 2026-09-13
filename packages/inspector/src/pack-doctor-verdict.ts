import { settleVerdict, type IVerdictCoverage } from '@shrkcrft/core';
import type { IPackDoctorVerdict } from './i-pack-doctor-verdict.ts';
import type { IPackDoctorReport } from './pack-doctor.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

/**
 * What a pack-doctor run examined, as coverage records:
 *
 *   - `packs` — the discovered packs. ZERO is an empty selection: "nothing to
 *     examine", never a pass. `emptyAcceptance` is the CLI verb's
 *     `--allow-empty` valve (`allowEmptyValve(args, discovered)`); every other
 *     reader passes nothing.
 *   - `compiled artifacts` — a pack's compiled build with no build record was
 *     never compared to its source (the doctor derives this from the one
 *     freshness authority).
 */
export function packDoctorCoverage(
  report: Pick<IPackDoctorReport, 'compiledArtifactCoverage'>,
  inspection: ISharkcraftInspection,
  emptyAcceptance: Pick<IVerdictCoverage, 'acceptedBy'> = {},
): IVerdictCoverage[] {
  const discovered = inspection.packs.discoveredPacks.length;
  const coverage: IVerdictCoverage[] = [
    {
      unit: 'packs',
      expected: discovered,
      examined: discovered,
      root: inspection.projectRoot,
      reason: 'no installed package declares a `sharkcraft` field in its package.json',
      ...emptyAcceptance,
    },
  ];
  if (report.compiledArtifactCoverage) coverage.push(report.compiledArtifactCoverage);
  return coverage;
}

/**
 * THE settlement of one pack-doctor run, next to `doctorVerdict`:
 * `IPackDoctorReport.passed` stays errors-only (its long-standing meaning);
 * the verdict is core's `settleVerdict` over {@link packDoctorCoverage}.
 *
 * `shrk packs doctor`, MCP `doctor_packs`, the quality packs gate (`shrk
 * quality`, MCP `get_quality_report`, the dashboard, the report site) and bare
 * `shrk check` read this — round 11 review: the 0-packs / compiled-artifact
 * settlement lived inline in the verb, and the other four read `passed: true`
 * over ZERO packs.
 */
export function packDoctorVerdict(
  report: Pick<IPackDoctorReport, 'passed' | 'compiledArtifactCoverage'>,
  inspection: ISharkcraftInspection,
  emptyAcceptance: Pick<IVerdictCoverage, 'acceptedBy'> = {},
): IPackDoctorVerdict {
  const coverage = packDoctorCoverage(report, inspection, emptyAcceptance);
  const settled = settleVerdict(report.passed ? 0 : 1, coverage);
  const packsDiscovered = inspection.packs.discoveredPacks.length;
  return { ...settled, coverage, packsDiscovered, examinedNothing: packsDiscovered === 0 };
}
