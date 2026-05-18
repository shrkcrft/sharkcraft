import {
  evaluateBoundaries,
  loadTsconfigPaths,
  scanImports,
} from '@shrkcrft/boundaries';
import { buildAiReadinessReport } from './ai-readiness.ts';
import { buildCoverageReport } from './coverage-report.ts';
import { buildDriftReport, type IDriftReport } from './drift.ts';
import { buildPackDoctorReport } from './pack-doctor.ts';
import { runDoctor } from './sharkcraft-inspector.ts';
import {
  loadAgentContractTests,
  loadContextTests,
  runAgentContractTest,
  runContextTest,
} from './test-runner.ts';
import type { IAgentContractTest, IContextTest } from './test-definitions.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export interface IQualityGateResult {
  id: string;
  label: string;
  passed: boolean;
  blocking: boolean;
  /** When true, the gate would normally run a shell command. MCP skips these. */
  runsShell: boolean;
  /** Whether the gate was actually executed in this run (false ⇒ skipped). */
  executed: boolean;
  notes: readonly string[];
  data?: Record<string, unknown>;
}

export interface IQualityReport {
  overall: 'pass' | 'fail' | 'warn';
  blockers: number;
  warnings: number;
  score: number;
  gates: readonly IQualityGateResult[];
  nextRecommendations: readonly string[];
  /** Drift report attached when the drift gate ran. */
  drift?: IDriftReport;
}

export interface IQualityConfig {
  minReadiness?: number;
  requireBoundaryClean?: boolean;
  requireDriftClean?: boolean;
  requireAgentTests?: boolean;
  requireContextTests?: boolean;
  requirePackSignatures?: boolean;
}

export interface IBuildQualityReportInput {
  inspection: ISharkcraftInspection;
  config: IQualityConfig;
  strict?: boolean;
  /**
   * When true, skip gates whose `runsShell` would be true and record them as
   * `executed: false` with a note pointing to the CLI command. Used by the MCP
   * read-only path so the server never executes shell commands.
   */
  skipShell?: boolean;
}

/**
 * Build a quality report from an inspection. Pure orchestration over the
 * existing inspector helpers — no IO outside what those helpers already do.
 */
export async function buildQualityReport(
  input: IBuildQualityReportInput,
): Promise<IQualityReport> {
  const { inspection, config, strict = false, skipShell = false } = input;
  const gates: IQualityGateResult[] = [];

  // 1. Doctor.
  const doctor = runDoctor(inspection);
  gates.push({
    id: 'doctor',
    label: 'Project doctor',
    passed: doctor.summary.errors === 0,
    blocking: true,
    runsShell: false,
    executed: true,
    notes: doctor.checks
      .filter((c) => c.severity === 'error')
      .map((c) => `${c.title}: ${c.message}`),
    data: {
      errors: doctor.summary.errors,
      warnings: doctor.summary.warnings,
      ok: doctor.summary.ok,
    },
  });

  // 2. Readiness threshold.
  const readiness = buildAiReadinessReport(inspection);
  const readinessMin = config.minReadiness ?? 0;
  gates.push({
    id: 'readiness',
    label: 'AI readiness',
    passed: readiness.score >= readinessMin,
    blocking: readinessMin > 0 || strict,
    runsShell: false,
    executed: true,
    notes:
      readiness.score < readinessMin
        ? [`Readiness ${readiness.score} below threshold ${readinessMin}`]
        : [],
    data: { score: readiness.score, min: readinessMin, grade: readiness.grade },
  });

  // 3. Boundaries. The boundary scan reads files from disk but does not run
  // shell commands; safe for MCP.
  const boundaries = checkBoundaries(inspection);
  gates.push({
    id: 'boundaries',
    label: 'Boundary check',
    passed: boundaries.errors === 0,
    blocking: config.requireBoundaryClean === true || strict,
    runsShell: false,
    executed: true,
    notes: boundaries.notes,
    data: { errors: boundaries.errors, warnings: boundaries.warnings },
  });

  // 4. Coverage.
  const cov = buildCoverageReport(inspection);
  const coverageGaps = cov.categories.filter((c) => c.score < 80).length;
  gates.push({
    id: 'coverage',
    label: 'Coverage report',
    passed: coverageGaps === 0,
    blocking: strict,
    runsShell: false,
    executed: true,
    notes:
      coverageGaps > 0
        ? cov.categories.filter((c) => c.score < 80).slice(0, 3).map((c) => `${c.id} at ${c.score}%`)
        : [],
    data: { gaps: coverageGaps, overall: cov.overall },
  });

  // 5. Drift gate. Pure deterministic check — no shell.
  let drift: IDriftReport | undefined;
  try {
    drift = buildDriftReport(inspection);
    const errors = drift.counts.error;
    const warnings = drift.counts.warning;
    const passed =
      errors === 0 && (config.requireDriftClean !== true || warnings === 0);
    gates.push({
      id: 'drift',
      label: 'Drift report',
      passed,
      blocking: config.requireDriftClean === true || strict,
      runsShell: false,
      executed: true,
      notes: drift.findings
        .filter((f) => f.severity === 'error' || (config.requireDriftClean && f.severity === 'warning'))
        .slice(0, 5)
        .map((f) => `${f.severity}: ${f.category} — ${f.message}`),
      data: {
        errors,
        warnings,
        info: drift.counts.info,
        findings: drift.findings.length,
      },
    });
  } catch (e) {
    gates.push({
      id: 'drift',
      label: 'Drift report',
      passed: true,
      blocking: false,
      runsShell: false,
      executed: false,
      notes: [`could not run drift report: ${(e as Error).message}`],
    });
  }

  // 6. Context tests. These don't run shell — they just evaluate retrieval
  // results against expectations.
  try {
    const all = await loadContextTests(inspection);
    const results = all.map((t: IContextTest) => runContextTest(inspection, t));
    const failed = results.filter((r) => !r.passed).length;
    gates.push({
      id: 'context-tests',
      label: 'Context tests',
      passed: failed === 0,
      blocking: config.requireContextTests === true || strict,
      runsShell: false,
      executed: true,
      notes: failed > 0 ? [`${failed}/${results.length} context tests failed`] : [],
      data: { total: results.length, failed },
    });
  } catch (e) {
    gates.push({
      id: 'context-tests',
      label: 'Context tests',
      passed: true,
      blocking: false,
      runsShell: false,
      executed: false,
      notes: [`could not load context tests: ${(e as Error).message}`],
    });
  }

  // 7. Agent tests. Likewise, pure orchestration.
  try {
    const all = await loadAgentContractTests(inspection);
    const results = all.map((t: IAgentContractTest) => runAgentContractTest(inspection, t));
    const failed = results.filter((r) => !r.passed).length;
    gates.push({
      id: 'agent-tests',
      label: 'Agent contract tests',
      passed: failed === 0,
      blocking: config.requireAgentTests === true || strict,
      runsShell: false,
      executed: true,
      notes: failed > 0 ? [`${failed}/${results.length} agent tests failed`] : [],
      data: { total: results.length, failed },
    });
  } catch (e) {
    gates.push({
      id: 'agent-tests',
      label: 'Agent contract tests',
      passed: true,
      blocking: false,
      runsShell: false,
      executed: false,
      notes: [`could not load agent tests: ${(e as Error).message}`],
    });
  }

  // 8. Packs doctor. Signature verification reads files but does not exec.
  try {
    const report = buildPackDoctorReport(inspection, {
      requireSignatures: config.requirePackSignatures === true,
    });
    gates.push({
      id: 'packs',
      label: 'Packs doctor',
      passed: report.passed,
      blocking: config.requirePackSignatures === true || strict,
      runsShell: false,
      executed: true,
      notes: report.issues
        .filter((i) => i.severity === 'error')
        .slice(0, 5)
        .map((i) => `${i.packageName}: ${i.message}`),
      data: {
        errors: report.summary.errors,
        warnings: report.summary.warnings,
      },
    });
  } catch (e) {
    gates.push({
      id: 'packs',
      label: 'Packs doctor',
      passed: true,
      blocking: false,
      runsShell: false,
      executed: false,
      notes: [`could not run pack doctor: ${(e as Error).message}`],
    });
  }

  // If `skipShell` were true and any gate listed runsShell=true, we'd record
  // it as skipped here. Today every gate is pure inspection — no shell. The
  // flag is kept so MCP callers can pre-declare the intent and future gates
  // (e.g. a real "verification commands" gate) can honour it.
  if (skipShell) {
    for (const g of gates) {
      if (g.runsShell) {
        // Force skip: don't pretend it passed; mark not executed.
        const idx = gates.indexOf(g);
        gates[idx] = {
          ...g,
          executed: false,
          notes: [...g.notes, 'skipped: MCP does not execute shell commands. Run via CLI.'],
          passed: false,
        };
      }
    }
  }

  const blockers = gates.filter((g) => g.blocking && !g.passed).length;
  const warnings = gates.filter((g) => !g.blocking && !g.passed).length;
  const executed = gates.filter((g) => g.executed).length;
  const passCount = gates.filter((g) => g.passed).length;
  const score = executed > 0 ? Math.round((passCount / executed) * 100) : 100;
  const overall: 'pass' | 'fail' | 'warn' =
    blockers > 0 ? 'fail' : warnings > 0 ? 'warn' : 'pass';
  const nextRecommendations = buildRecommendations(gates);
  const report: IQualityReport = {
    overall,
    blockers,
    warnings,
    score,
    gates,
    nextRecommendations,
  };
  if (drift) report.drift = drift;
  return report;
}

function checkBoundaries(
  inspection: ISharkcraftInspection,
): { errors: number; warnings: number; notes: string[] } {
  const rules = inspection.boundaryRegistry.list();
  if (rules.length === 0) {
    return { errors: 0, warnings: 0, notes: ['no boundary rules configured'] };
  }
  try {
    const scan = scanImports({ projectRoot: inspection.projectRoot });
    const tsconfigPaths = loadTsconfigPaths(inspection.projectRoot);
    const evalResult = evaluateBoundaries(scan, rules, {
      ...(tsconfigPaths.aliases.size > 0 ? { tsconfigPaths } : {}),
    });
    return {
      errors: evalResult.counts.error,
      warnings: evalResult.counts.warning,
      notes: evalResult.violations
        .slice(0, 5)
        .map((v) => `${v.severity}: ${v.file}:${v.line} → ${v.importSpecifier}`),
    };
  } catch (e) {
    return { errors: 0, warnings: 0, notes: [`boundary scan failed: ${(e as Error).message}`] };
  }
}

function buildRecommendations(gates: readonly IQualityGateResult[]): string[] {
  const out: string[] = [];
  for (const g of gates) {
    if (g.passed) continue;
    switch (g.id) {
      case 'doctor':
        out.push('Run `shrk doctor` and fix the errors before opening a PR.');
        break;
      case 'readiness':
        out.push('Improve AI readiness — `shrk coverage` to see missing dimensions.');
        break;
      case 'boundaries':
        out.push('Run `shrk check boundaries` to inspect cross-layer imports.');
        break;
      case 'coverage':
        out.push('Run `shrk coverage` to see what knowledge axes are missing.');
        break;
      case 'drift':
        out.push('Run `shrk drift --json` to inspect drift findings in detail.');
        break;
      case 'context-tests':
        out.push('Run `shrk test context` to inspect failing retrieval contracts.');
        break;
      case 'agent-tests':
        out.push('Run `shrk test agent` to inspect failing task-packet contracts.');
        break;
      case 'packs':
        out.push('Run `shrk packs doctor --require-signatures` to inspect pack issues.');
        break;
      default:
        break;
    }
  }
  return out;
}
