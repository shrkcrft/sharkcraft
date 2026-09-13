import type { IVerdictCoverage } from '@shrkcrft/core';
import { ContributionKind } from './contribution-kind.ts';
import { collectKindRejections } from './contribution-load-failures.ts';
import type { IScaffoldPatternDoctorReport } from './i-scaffold-pattern-doctor-report.ts';
import {
  doctorScaffoldPatterns,
  enumerateScaffoldPatternCandidates,
  loadScaffoldPatternsFromInspection,
  scaffoldPatternCoverage,
  type IScaffoldPatternEnumeration,
} from './scaffold-patterns.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

const NO_ENUMERATION: IScaffoldPatternEnumeration = { byPattern: new Map(), firstMatch: [], walked: 0 };

/**
 * THE scaffold-pattern doctor (round 13): load (THE rejection channel names
 * every refused pattern), validate the definitions, walk ONCE with THE
 * enumeration `infer templates` attributes candidates with, and settle every
 * `matchPaths` glob and every pattern through THE liveness authority.
 *
 * `shrk scaffolds doctor` and MCP `get_scaffold_pattern_doctor` both read it
 * and propose through `assetDoctorProposedExit` — the MCP tool used to drop
 * the patterns the loader refused and to return no verdict, so it answered
 * "0 errors" where the CLI exited 1.
 *
 * `emptyAcceptance` is the CLI's `--allow-empty` valve for zero patterns (`{}`
 * from MCP: nothing declared is NOT VERIFIED).
 */
export async function buildScaffoldPatternDoctorReport(
  inspection: ISharkcraftInspection,
  emptyAcceptance: Pick<IVerdictCoverage, 'acceptedBy'> = {},
): Promise<IScaffoldPatternDoctorReport> {
  const result = await loadScaffoldPatternsFromInspection(inspection);
  const enumeration =
    result.patterns.length > 0 ? enumerateScaffoldPatternCandidates(inspection.projectRoot, result.patterns) : undefined;
  const issues = doctorScaffoldPatterns(result.patterns, inspection, enumeration);
  const measured = scaffoldPatternCoverage(result.patterns, enumeration ?? NO_ENUMERATION);
  const coverage: readonly IVerdictCoverage[] =
    result.patterns.length === 0
      ? [
          ...measured.coverage,
          {
            unit: 'scaffold patterns',
            expected: 0,
            examined: 0,
            reason: 'no scaffold patterns declared',
            ...emptyAcceptance,
          },
        ]
      : measured.coverage;
  // A pattern the loader REFUSED never reaches `doctorScaffoldPatterns` (it is
  // not loaded) — it is an error here (round 12, 12.1).
  const rejected = await collectKindRejections(inspection, [ContributionKind.ScaffoldPattern]);
  return {
    patterns: result.patterns,
    loadWarnings: result.warnings,
    rejected,
    issues,
    errors: issues.filter((i) => i.severity === 'error').length + rejected.length,
    warnings: issues.filter((i) => i.severity === 'warning').length,
    measured,
    coverage,
    patternCoverage: [...(enumeration?.byPattern.values() ?? [])].map((c) => ({
      patternId: c.patternId,
      files: c.files.length,
      perMatchPath: c.perMatchPath,
    })),
  };
}
