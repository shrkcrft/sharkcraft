import { buildAiReadinessReport } from './ai-readiness.ts';
import { describeBoundaryConfiguration } from './boundary-configuration-status.ts';
import { boundaryLoadIssueLabel, runBoundaryCheck } from './run-boundary-check.ts';
import { buildCoverageReport } from './coverage-report.ts';
import { buildDriftReport, type IDriftReport } from './drift.ts';
import { buildPackDoctorReportAsync } from './pack-doctor.ts';
import { packDoctorVerdict } from './pack-doctor-verdict.ts';
import { declaredGatePlaneRules } from './declared-gate-plane-rules.ts';
import { knowledgeStaleQualityGate } from './knowledge-stale-quality-gate.ts';
import { runDoctor } from './sharkcraft-inspector.ts';
import { doctorVerdict } from './doctor-verdict.ts';
import {
  loadAgentContractTests,
  loadContextTests,
  runAgentContractTest,
  runContextTest,
} from './test-runner.ts';
import type { IAgentContractTest, IContextTest } from './test-definitions.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import { warmReferenceRegistries } from './reference-registry.ts';
import { coverageShortfall, type IVerdictCoverage } from '@shrkcrft/core';
import { qualityReportCoverage } from './quality-report-coverage.ts';
import {
  buildDeclaredXrefReport,
  declaredXrefCoverage,
  declaredXrefSummaryLine,
  isBrokenXref,
} from './declared-cross-references.ts';

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
  /**
   * `fail` — a blocking gate failed. `not-verified` — no blocking gate failed,
   * but a gate could not run, examined nothing while required, or examined
   * only part of its scope (core's `coverageShortfall` over {@link coverage}):
   * never a pass, for MCP, the dashboard and the report site alike. `warn` —
   * a non-blocking gate failed. `pass` — every gate that was asked for
   * examined its whole scope and passed.
   */
  overall: 'pass' | 'fail' | 'warn' | 'not-verified';
  blockers: number;
  warnings: number;
  score: number;
  gates: readonly IQualityGateResult[];
  nextRecommendations: readonly string[];
  /** Drift report attached when the drift gate ran. */
  drift?: IDriftReport;
  /**
   * What the report examined (unit `quality gates`), from the one
   * classification `shrk quality` also reads (`examineQualityGate`).
   * Always set by `buildQualityReport`.
   */
  coverage?: IVerdictCoverage;
  /** The shortfall that made `overall` `not-verified`, when one did. */
  shortfalls?: readonly string[];
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
  /** Narrow the knowledge stale-check gate to entries referencing these files (`shrk quality --changed-only`). */
  changedFiles?: readonly string[];
  /**
   * Set ONLY by `shrk quality`, which runs the seven data-defined gate planes
   * itself (some spawn shells). Every other consumer — MCP, the dashboard, the
   * report site — does not run them, so it gets a `gate-planes` row with
   * `executed: false` whenever the config declares any plane rule: the report
   * is then `not-verified`, never a `pass` over rules it never evaluated.
   */
  callerRunsGatePlanes?: boolean;
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

  // 1. Doctor. A scope the doctor could not verify (a compiled pack build with
  // no build record) is PARTIAL here, exactly as `shrk doctor` settles it to 2.
  const doctor = runDoctor(inspection);
  // THE doctor settlement (`doctorVerdict`) — the one `shrk doctor`, `shrk
  // check`, the dashboard and MCP `inspect_sharkcraft_setup` read.
  const doctorShortfalls = doctorVerdict(doctor).shortfalls;
  gates.push({
    id: 'doctor',
    label: 'Project doctor',
    passed: doctor.summary.errors === 0,
    blocking: true,
    runsShell: false,
    executed: true,
    notes: [
      ...doctor.checks.filter((c) => c.severity === 'error').map((c) => `${c.title}: ${c.message}`),
      ...(doctorShortfalls.length > 0 ? [`NOT VERIFIED — ${doctorShortfalls.join('; ')}`] : []),
    ],
    data: {
      errors: doctor.summary.errors,
      warnings: doctor.summary.warnings,
      ok: doctor.summary.ok,
      ...(doctorShortfalls.length > 0 ? { partial: true, shortfalls: doctorShortfalls } : {}),
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
  // shell commands; safe for MCP. Through the ONE boundary orchestrator
  // (round 11), so this gate reports exactly what `check boundaries` does —
  // an errored rule counts as an error, a partial scope is never a pass.
  const boundaries = checkBoundaries(inspection);
  gates.push({
    id: 'boundaries',
    label: 'Boundary check',
    passed: boundaries.errors === 0,
    blocking: config.requireBoundaryClean === true || strict,
    runsShell: false,
    executed: true,
    notes: boundaries.notes,
    data: {
      errors: boundaries.errors,
      warnings: boundaries.warnings,
      examinedNothing: boundaries.examinedNothing === true,
      ...(boundaries.partial ? { partial: true, shortfalls: boundaries.shortfalls ?? [] } : {}),
    },
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
      // A gate that threw proved NOTHING. `passed: true` here would fold an
      // unmeasured verdict into the green count and the score — the exact
      // silent-green the loud-skip contract exists to prevent. `executed:
      // false` marks it unmeasured; the score below excludes it either way.
      passed: false,
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
      // `failed === 0` over ZERO tests is not a pass — it examined nothing.
      // Flagged so the CLI aggregate reports the gate as skipped (a deliberate
      // skip when the gate is optional, NOT verified when it is required).
      data: { total: results.length, failed, examinedNothing: results.length === 0 },
    });
  } catch (e) {
    gates.push({
      id: 'context-tests',
      label: 'Context tests',
      // A gate that threw proved NOTHING. `passed: true` here would fold an
      // unmeasured verdict into the green count and the score — the exact
      // silent-green the loud-skip contract exists to prevent. `executed:
      // false` marks it unmeasured; the score below excludes it either way.
      passed: false,
      blocking: false,
      runsShell: false,
      executed: false,
      notes: [`could not load context tests: ${(e as Error).message}`],
    });
  }

  // 7. Agent tests. Likewise, pure orchestration.
  try {
    // The agent-test runner reads the shared reference registry (MCP ≡ CLI);
    // a warm here keeps any command resolver a CLI caller already injected.
    await warmReferenceRegistries(inspection);
    const all = await loadAgentContractTests(inspection);
    const results = all.map((t: IAgentContractTest) => runAgentContractTest(inspection, t));
    // A FAILURE is a test whose verdict is `fail`. A `not-verified` test (an
    // expectation the runner could not evaluate — e.g. an `expectedCommands`
    // entry with no command index injected, the MCP path) is an unexamined
    // unit, the same verdict `shrk test agent` gives it (2): never a failure,
    // never a pass. With no real failure the gate is PARTIAL, which the CLI
    // aggregate reports as an accidental skip (NOT VERIFIED).
    const failed = results.filter((r) => r.verdict === 'fail').length;
    const notVerified = results.filter((r) => r.verdict === 'not-verified');
    const partial = failed === 0 && notVerified.length > 0;
    const notVerifiedNote = `NOT VERIFIED — ${notVerified.length} agent test(s) could not be evaluated: ${notVerified
      .slice(0, 5)
      .map((r) => r.id)
      .join(', ')}${notVerified.length > 5 ? ` (+${notVerified.length - 5} more)` : ''}`;
    gates.push({
      id: 'agent-tests',
      label: 'Agent contract tests',
      passed: failed === 0,
      blocking: config.requireAgentTests === true || strict,
      runsShell: false,
      executed: true,
      notes: [
        ...(failed > 0 ? [`${failed}/${results.length} agent tests failed`] : []),
        ...(notVerified.length > 0 ? [notVerifiedNote] : []),
      ],
      // Zero agent tests examined nothing — see the context-tests note above.
      data: {
        total: results.length,
        failed,
        notVerified: notVerified.length,
        examinedNothing: results.length === 0,
        ...(partial ? { partial: true, shortfalls: [notVerifiedNote] } : {}),
      },
    });
  } catch (e) {
    gates.push({
      id: 'agent-tests',
      label: 'Agent contract tests',
      // A gate that threw proved NOTHING. `passed: true` here would fold an
      // unmeasured verdict into the green count and the score — the exact
      // silent-green the loud-skip contract exists to prevent. `executed:
      // false` marks it unmeasured; the score below excludes it either way.
      passed: false,
      blocking: false,
      runsShell: false,
      executed: false,
      notes: [`could not load agent tests: ${(e as Error).message}`],
    });
  }

  // 8. Packs doctor. Signature verification reads files but does not exec.
  // Settled by THE pack-doctor verdict (`packDoctorVerdict`, the one `shrk
  // packs doctor` exits on): ZERO packs examined nothing — a deliberate skip
  // when the gate is optional, NOT verified when required — and a compiled
  // build never compared to its source is PARTIAL. Never `passed` over either.
  try {
    // THE async doctor `shrk packs doctor` runs: registry-backed rejections
    // included, so this row cannot pass a pack the verb fails (R12-X2).
    const report = await buildPackDoctorReportAsync(inspection, {
      requireSignatures: config.requirePackSignatures === true,
    });
    const verdict = packDoctorVerdict(report, inspection);
    const compiledShortfall = report.compiledArtifactCoverage
      ? coverageShortfall(report.compiledArtifactCoverage)
      : undefined;
    gates.push({
      id: 'packs',
      label: 'Packs doctor',
      passed: report.passed,
      blocking: config.requirePackSignatures === true || strict,
      runsShell: false,
      executed: true,
      notes: [
        ...report.issues
          .filter((i) => i.severity === 'error')
          .slice(0, 5)
          .map((i) => `${i.packageName}: ${i.message}`),
        ...(verdict.examinedNothing ? ['0 packs discovered — nothing to examine'] : []),
        ...(compiledShortfall ? [`NOT VERIFIED — ${compiledShortfall}`] : []),
      ],
      data: {
        errors: report.summary.errors,
        warnings: report.summary.warnings,
        packsDiscovered: verdict.packsDiscovered,
        ...(verdict.examinedNothing ? { examinedNothing: true } : {}),
        ...(compiledShortfall !== undefined && report.passed ? { partial: true, shortfalls: [compiledShortfall] } : {}),
      },
    });
  } catch (e) {
    gates.push({
      id: 'packs',
      label: 'Packs doctor',
      // A gate that threw proved NOTHING. `passed: true` here would fold an
      // unmeasured verdict into the green count and the score — the exact
      // silent-green the loud-skip contract exists to prevent. `executed:
      // false` marks it unmeasured; the score below excludes it either way.
      passed: false,
      blocking: false,
      runsShell: false,
      executed: false,
      notes: [`could not run pack doctor: ${(e as Error).message}`],
    });
  }

  // 9. Declared cross-references (round 11, 4.2) — the collector the
  // self-config doctor reads, so the bundle and the verb cannot disagree. A
  // dangling id is a warning (non-blocking unless --strict); a dangling
  // `supersededBy`, a supersession cycle or an unknown facet kind blocks. An id
  // that could not be looked up is an unexamined unit: with no blocking error
  // the gate is PARTIAL (never a pass), and `data.coverage` carries the record.
  try {
    const xrefs = await buildDeclaredXrefReport(inspection);
    const coverage = declaredXrefCoverage(xrefs);
    const c = xrefs.counts;
    const nothing = c.ids === 0 && xrefs.issues.length === 0 && xrefs.examined.unreadSources.length === 0;
    const shortfall = nothing ? undefined : coverageShortfall(coverage);
    gates.push({
      id: 'cross-references',
      label: 'Declared cross-references',
      passed: c.errors === 0 && ((c.warnings === 0) || shortfall !== undefined),
      blocking: c.errors > 0 || (strict && !nothing),
      runsShell: false,
      executed: true,
      notes: [
        declaredXrefSummaryLine(xrefs),
        ...xrefs.rows
          .filter(isBrokenXref)
          .slice(0, 5)
          .map((r) => `${r.severity}: ${r.message}${r.file ? ` (${r.file})` : ''}`),
        ...xrefs.issues.slice(0, 3).map((i) => `${i.severity}: ${i.message}`),
        ...(shortfall ? [`NOT VERIFIED — ${shortfall}`] : []),
      ],
      data: {
        ids: c.ids,
        dangling: c.dangling,
        wrongKind: c.wrongKind,
        unverified: c.unverified,
        errors: c.errors,
        warnings: c.warnings,
        coverage,
        ...(nothing ? { examinedNothing: true } : {}),
        ...(shortfall !== undefined && c.errors === 0 ? { partial: true } : {}),
      },
    });
  } catch (e) {
    gates.push({
      id: 'cross-references',
      label: 'Declared cross-references',
      // Could not run → proved nothing; never folded into a pass.
      passed: false,
      blocking: false,
      runsShell: false,
      executed: false,
      notes: [`could not collect declared cross-references: ${(e as Error).message}`],
    });
  }

  // 10. The knowledge stale-check — THE gate `shrk knowledge stale-check` and
  // `shrk quality` settle (`knowledgeStaleQualityGate`), so this report and
  // the CLI bundle cannot disagree about the corpus (round 11 review: it was
  // CLI-only, and MCP read `pass` over a stale corpus `shrk quality` failed).
  gates.push(await knowledgeStaleQualityGate(inspection, input.changedFiles));

  // 11. The seven data-defined gate planes. `shrk quality` runs them itself;
  // every other consumer does not (some spawn shells), so a config that
  // declares plane rules gets a NOT-RUN row — the report is `not-verified`,
  // never a `pass` over rules nobody evaluated.
  if (input.callerRunsGatePlanes !== true) {
    const planes = await declaredGatePlaneRules(inspection.projectRoot);
    if (planes.total > 0 || planes.loadError !== undefined) {
      const breakdown = Object.entries(planes.byPlane)
        .map(([plane, n]) => `${plane} ${n}`)
        .join(', ');
      gates.push({
        id: 'gate-planes',
        label: 'Data-defined gate planes',
        passed: false,
        blocking: false,
        runsShell: false,
        executed: false,
        notes: [
          planes.loadError !== undefined
            ? `could not resolve the config (${planes.loadError}), so the data-defined planes were not evaluated — run \`shrk gates check\``
            : `${planes.total} plane rule(s) declared (${breakdown}) — not evaluated by this report; run \`shrk gates check\` (or \`shrk quality\`)`,
        ],
        data: { rules: planes.total, byPlane: planes.byPlane },
      });
    }
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
  // Settled through core's coverage rule, like every CLI verdict: a blocking
  // failure is `fail`; otherwise a gate that could not run, examined nothing
  // while required, or examined only part of its scope makes the report
  // `not-verified` — never `pass` (or `warn`) over it.
  const coverage = qualityReportCoverage(gates);
  const shortfall = coverageShortfall(coverage);
  const overall: IQualityReport['overall'] =
    blockers > 0 ? 'fail' : shortfall !== undefined ? 'not-verified' : warnings > 0 ? 'warn' : 'pass';
  const nextRecommendations = buildRecommendations(gates);
  const report: IQualityReport = {
    overall,
    blockers,
    warnings,
    score,
    gates,
    nextRecommendations,
    coverage,
    shortfalls: shortfall !== undefined ? [shortfall] : [],
  };
  if (drift) report.drift = drift;
  return report;
}

function checkBoundaries(inspection: ISharkcraftInspection): {
  errors: number;
  warnings: number;
  notes: string[];
  examinedNothing?: boolean;
  partial?: boolean;
  shortfalls?: string[];
} {
  const rules = inspection.boundaryRegistry.list();
  const loadIssues = inspection.boundaryLoadIssues ?? [];
  if (rules.length === 0 && loadIssues.length === 0) {
    // Zero errors over ZERO rules is not a clean boundary check — it examined
    // nothing. Flagged so the CLI aggregate reports it as a skip, not a pass;
    // the notes say WHY (e.g. a boundaries.ts that is not listed).
    return {
      errors: 0,
      warnings: 0,
      notes: ['no boundary rules configured', ...describeBoundaryConfiguration(inspection).diagnostics],
      examinedNothing: true,
    };
  }
  try {
    const r = runBoundaryCheck(inspection);
    // An errored rule, a stale exception and a failOnEmpty skip fail the gate
    // exactly as they fail `check boundaries`.
    const errors =
      r.counts.error +
      r.loadIssues.length +
      r.staleExceptions.length +
      r.rules.filter((x) => x.failedOnEmpty === true).length;
    const partial = errors === 0 && r.exitCode === 2;
    return {
      errors,
      warnings: r.counts.warning,
      notes: [
        ...r.violations.slice(0, 5).map((v) => `${v.severity}: ${v.file}:${v.line} → ${v.importSpecifier}`),
        ...r.loadIssues.map((i) => `error: ${boundaryLoadIssueLabel(i)} (${i.file}) — ${i.kind}: ${i.issues.join('; ')} — NOT evaluated`),
        ...r.staleExceptions.map((s) => `error: ${s.file} — ${s.message}`),
        ...(partial ? [`NOT VERIFIED — ${r.shortfalls.slice(0, 3).join('; ')}`] : []),
        // Round 13 (lane B): dead selector units and went-live expectEmpty
        // markers are ADVISORY here — listed, never an error: `check
        // boundaries --fail-on-dead-units` is where they fail. Quality used to
        // report `passed` with no note while `check boundaries` withheld its ✓.
        ...r.deadUnits.slice(0, 5).map((d) => `advisory: dead selector unit [${d.unit}] ${d.ruleId}: ${d.selector} — ${d.reason}`),
        ...(r.deadUnits.length > 5
          ? [`advisory: ${r.deadUnits.length - 5} more dead selector unit(s) — \`shrk check boundaries\` lists them`]
          : []),
        // A PACK marker that went live is INFO (round 13 review), as `check
        // boundaries` prints it in its own block — never counted as advisory.
        ...r.wentLive
          .slice(0, 5)
          .map((u) => `${u.packageName !== undefined ? 'info' : 'advisory'}: [${u.unit}] ${u.ruleId}: ${u.selector} — ${u.reason}`),
        ...(r.wentLive.length > 5
          ? [`advisory: ${r.wentLive.length - 5} more went-live expectEmpty marker(s) — \`shrk check boundaries\` lists them`]
          : []),
        // …and every intended-empty unit the run ACCEPTED is printed, never
        // silent (round 13 review) — the orchestrator's settled acceptance
        // lines (present only at exit 0), worded as the gate planes' coverage
        // item prints theirs.
        ...r.accepted.map((a) => `accepted: ${a}`),
      ],
      ...(partial ? { partial: true, shortfalls: [...r.shortfalls] } : {}),
    };
  } catch (e) {
    return { errors: 0, warnings: 0, notes: [`boundary scan failed: ${(e as Error).message}`] };
  }
}

function buildRecommendations(gates: readonly IQualityGateResult[]): string[] {
  const out: string[] = [];
  for (const g of gates) {
    if (g.id === 'agent-tests' && g.passed && g.data?.['partial'] === true) {
      // Not a failure, not a pass: an expectation the runner could not evaluate.
      out.push('Run `shrk test agent` from the CLI — it injects the command index, so every `expectedCommands` entry is evaluated.');
      continue;
    }
    // A gate that passed over PART of its scope still gets its repro: the
    // report is not-verified because of it.
    if (g.passed && g.data?.['partial'] !== true) continue;
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
      case 'cross-references':
        out.push('Run `shrk self-config xrefs --dangling-only` to list dangling cross-reference ids (`shrk self-config resolve <id>` explains one).');
        break;
      case 'knowledge-stale':
        out.push('Run `shrk knowledge stale-check` to see the stale, missing and unverifiable knowledge references.');
        break;
      case 'gate-planes':
        out.push('Run `shrk gates check` (or `shrk quality`) to evaluate the data-defined gate planes this report did not run.');
        break;
      default:
        break;
    }
  }
  return out;
}
