import {
  boundaryRuleSourceFiles,
  buildImportHygieneReport,
  describeBoundaryConfiguration,
  gitShowFile,
  importHygieneCoverage,
  importHygieneSubjects,
  inspectSharkcraft,
  isProjectConfigAbsent,
  resolveChangedFiles,
  resolveProjectConfig,
  runBoundaryCheck,
  type ChangedScopeMode,
  type IChangedScopeOptions,
  type ISharkcraftInspection,
} from '@shrkcrft/inspector';
import {
  coverageShortfall,
  settleRuleStatus,
  type IPolicyRule,
  type IRegistrationIdiom,
  type IVerdictCoverage,
  type IWiringRule,
} from '@shrkcrft/core';
import {
  buildRegistrationGraph,
  measureIdiomRoleCoverage,
  planeScanExcludeDirs,
  providedTokensFromEntries,
  registrationTouchesChanged,
  registrationUnprovidedVerdict,
  runPolicyLint,
  runWiring,
  unreadDirectoryContains,
  type IUnprovidedToken,
} from '@shrkcrft/boundaries';
import { computeDeletedOrphans } from '../diff/deleted-orphans.ts';
import { deletedOrphanCoverage } from '../diff/deleted-orphan-coverage.ts';
import { ExitCode } from '../exit-codes.ts';
import { buildGateEnvelope, type IGateEnvelope, type IGateRuleResult } from '../gates/gate-envelope.ts';
import { seamRejectedRules } from '../gates/seam-rejected-rules.ts';
import { unitStateNotes } from '../gates/unit-state-notes.ts';
import { DEAD_SELECTOR_CAUSES, type IUnitLiveness } from '@shrkcrft/core';

export const FINISH_SCHEMA = 'sharkcraft.finish/v1' as const;

/** Files in the boundary/import/wiring domain — a change outside it evaluates nothing there. */
const CODE_FILE = /\.(?:m|c)?[jt]sx?$/;
function codeFilesOf(files: readonly string[]): string[] {
  return files.filter((f) => CODE_FILE.test(f));
}

/**
 * Outcome of one sub-gate. `skipped` = nothing to evaluate (loud, never silent
 * green). `partial` = ran, found nothing wrong, and did NOT examine all of its
 * scope (a coverage shortfall) — set ONLY by runFinishGates' settle step, never
 * by a sub-gate producer, so text and --json report the same word.
 */
export type FinishGateStatus = 'pass' | 'fail' | 'skipped' | 'partial';

/** One failing/relevant item, with file:line where the engine provides it. */
export interface IFinishItem {
  readonly file?: string;
  readonly line?: number;
  readonly message: string;
}

export interface IFinishGate {
  readonly name: 'boundaries' | 'imports' | 'wiring' | 'unprovided' | 'policy' | 'orphans' | 'arch';
  readonly status: FinishGateStatus;
  /** One-line reason (e.g. why skipped, or the error/warning counts). */
  readonly detail: string;
  readonly errors: number;
  readonly warnings: number;
  /** Failing/notable items (capped by the renderer, full in JSON). */
  readonly items: readonly IFinishItem[];
  /**
   * Advisory gates report signal but NEVER decide the verdict: they cannot fail
   * the composite and do not count as "something was evaluated" (so an advisory
   * pass can't turn an all-skipped run green). Used by `arch`, whose cycle
   * findings are change-informative but must not attribute a pre-existing cycle
   * to this changeset.
   */
  readonly advisory?: boolean;
  /**
   * What the sub-gate examined against what it was asked to (round 11). A
   * `pass` whose coverage has a shortfall proved nothing about the rest: the
   * settle step reports it `partial` and the composite is not-verified (2).
   * Set by the boundaries, wiring, policy and orphans sub-gates.
   */
  readonly coverage?: IVerdictCoverage;
  /**
   * Further coverage records the sub-gate settled beside {@link coverage}
   * (round 13 review). The unprovided sub-gate reads one role record per idiom
   * (and each idiom's expectEmpty acceptance) plus the graph's read scope; a
   * single `coverage` kept one of them, so a second idiom's acceptance was
   * never printed and a second dead role never named. Each becomes its own
   * envelope row, and the settle step derives `partial` / `shortfall` over
   * every record.
   */
  readonly extraCoverage?: readonly IVerdictCoverage[];
  /**
   * The coverage shortfall, derived by the settle step (a producer's value is
   * overwritten) — present whenever {@link coverage} has one, so a --json
   * reader sees WHY a gate is `partial` (or what a failing gate never examined).
   */
  readonly shortfall?: string;
  /**
   * Advisory notes that NEVER decide the verdict and are not items (round 13):
   * the boundaries sub-gate lists its dead selector units and went-live
   * expectEmpty markers here — what `check boundaries` withholds its ✓ for —
   * without turning them into envelope violations.
   */
  readonly notes?: readonly string[];
}

/**
 * A sub-gate's REPORTED status, settled against its coverage — the ONE place
 * finish derives `partial`, through core's one rule (`settleRuleStatus`: a
 * `passed` whose coverage has a shortfall is `partial`). Finish's sub-gates say
 * `pass`, so the status is spoken in the envelope's vocabulary for the call.
 * The fold, the text renderer and --json all read the settled gate; none
 * re-derives it. (The gate envelope re-derives the same word through the same
 * core function when a `partial` gate is handed to it as `passed`.)
 */
function settleFinishGate(g: IFinishGate): IFinishGate {
  const { shortfall: _producerShortfall, ...rest } = g;
  // Every record the sub-gate settled — `coverage`, then `extraCoverage` —
  // so a gap in any of them is `partial` and named (round 13 review).
  const records = [...(g.coverage !== undefined ? [g.coverage] : []), ...(g.extraCoverage ?? [])];
  // Over several records a gap names its subject (the idiom), or two dead
  // roles would read as the same sentence twice.
  const labelled = records.length > 1;
  const gaps = records.flatMap((c) => {
    const s = coverageShortfall(c);
    if (s === undefined) return [];
    return [{ record: c, shortfall: labelled && c.subject !== undefined ? `${c.subject}: ${s}` : s }];
  });
  const first = gaps[0];
  if (first === undefined) return rest;
  const settled = settleRuleStatus(g.status === 'pass' ? 'passed' : g.status, first.record);
  return {
    ...rest,
    ...(settled === 'partial' ? { status: 'partial' as const } : {}),
    shortfall: gaps.map((x) => x.shortfall).join('; '),
  };
}

export interface IFinishImpact {
  readonly ran: boolean;
  readonly risk?: string;
  readonly directDependents?: number;
  readonly transitiveDependents?: number;
  /** Why the summary could not run (no graph index / no changed files). */
  readonly note?: string;
}

export interface IFinishReport {
  readonly schema: typeof FINISH_SCHEMA;
  readonly scope: {
    readonly mode: 'worktree' | 'staged' | 'since' | 'files';
    readonly files: readonly string[];
    readonly fileCount: number;
  };
  readonly gates: readonly IFinishGate[];
  readonly impact: IFinishImpact;
  /**
   * The honest tri-state verdict:
   *   `fail`         — a deciding gate failed (or the config could not load).
   *   `not-verified` — NOTHING was actually evaluated (every deciding gate
   *                    skipped / the changed scope had nothing to gate), or a
   *                    deciding gate passed over part of its scope. Never a
   *                    green `pass` — "evaluated nothing" is `2`, not `0`.
   *   `pass`         — at least one deciding gate ran over a real scope and every
   *                    deciding gate passed over all of it.
   */
  readonly verdict: 'pass' | 'fail' | 'not-verified';
  /** The exit code this verdict maps to (0 pass / 1 fail / 2 not-verified). Equals `gate.exit`. */
  readonly exit: ExitCode;
  /** Total warning-severity findings across gates (non-blocking). */
  readonly warnings: number;
  /** Set when sharkcraft.config.ts could not be loaded — forces a `fail`. */
  readonly configError?: string;
  readonly summary: string;
  readonly nextAction: string;
  /**
   * The shared gate envelope (round 11): one row per deciding sub-gate that
   * evaluated something, settled against every sub-gate's coverage. The exit
   * and verdict above ARE this envelope's — finish folds through the same
   * builder every verdict verb uses, never a private fold.
   */
  readonly gate: IGateEnvelope;
}

export interface IRunFinishInput {
  readonly cwd: string;
  readonly mode: 'worktree' | 'staged' | 'since' | 'files';
  readonly scope: IChangedScopeOptions;
  /**
   * The `--allow-empty` valve, supplied by the command (`allowEmptyValve(args,
   * expected)`), applied to the run coverage: a changeset with nothing any
   * deciding gate could evaluate settles to 0 only when the caller accepted it.
   */
  readonly emptyValve?: (expected: number) => Pick<IVerdictCoverage, 'acceptedBy'>;
}

/** The base ref the unprovided gate diffs against to spot removed providers. */
function baseRefFor(input: IRunFinishInput): string | undefined {
  if (input.mode === 'files') return undefined; // an explicit file list has no diff base
  if (input.mode === 'since' && input.scope.since) return input.scope.since;
  return 'HEAD'; // worktree + staged both diff vs HEAD
}

/** Map the changed-scope onto the orphan check's diff inputs. */
function orphanOptsFor(input: IRunFinishInput): { since?: string; staged?: boolean } | undefined {
  if (input.mode === 'files') return undefined; // a file list has no diff to read deletions from
  if (input.mode === 'staged') return { staged: true };
  if (input.mode === 'since' && input.scope.since) return { since: input.scope.since };
  // Worktree mode: diff deletions vs HEAD so the orphan gate's "deleted" set
  // matches the working-tree scope the other gates use (not the whole branch).
  return { since: 'HEAD' };
}

/**
 * The composite "is this changeset safe to finish?" orchestrator. Runs every
 * deterministic CHANGED-ONLY gate inline — boundaries + import-hygiene + wiring
 * + policy + deleted-orphans — plus a best-effort impact summary, and folds
 * them into ONE pass/fail. This is the single trustworthy "done?" call an
 * autonomous agent needs and can't reliably assemble by hand (only shrk can run
 * the alias-resolved layer/wiring gates). Honors the `0-rules → skipped`
 * semantics so a no-op sub-check is reported, never silently passed. Read-only.
 */
export async function runFinishGates(input: IRunFinishInput): Promise<IFinishReport> {
  const { cwd } = input;
  const changed = resolveChangedFiles(input.scope);
  const changedFiles = changed.files;
  const gates: IFinishGate[] = [];

  // ── boundaries (changed-only, with rule escalation) ──────────────────
  const inspection = await inspectSharkcraft({ cwd });
  gates.push(boundariesGate(inspection, { mode: changed.mode, files: changedFiles }));

  // The boundary/import engines only reason about code files, and a file that
  // DEFINES rules (a boundaryFiles entry, the config) is a rule source, not a
  // subject: a changed rule file escalates its rules above; it is never
  // "scanned" as if it were the change under review. A change to non-code files
  // evaluates NOTHING here, so these gates SKIP rather than trivially pass.
  const ruleSources = new Set(boundaryRuleSourceFiles(inspection));
  const codeChanged = codeFilesOf(changedFiles).filter((f) => !ruleSources.has(f));

  // ── import hygiene (changed-only) ────────────────────────────────────
  // Hygiene reads existing .ts/.tsx sources only (THE subject list the engine
  // itself scans): a deleted file, a .js edit or a test fixture put nothing in
  // front of it, and a pass over nothing is not a pass.
  const hygieneFiles = importHygieneSubjects(cwd, codeChanged);
  if (codeChanged.length === 0) {
    gates.push(skip('imports', 'no code files in changed scope'));
  } else if (hygieneFiles.length === 0) {
    gates.push(skip('imports', `no existing .ts/.tsx source in the changed scope (${codeChanged.length} changed code file(s))`));
  } else {
    const report = buildImportHygieneReport(cwd, { files: hygieneFiles });
    const errors =
      report.counts?.['error'] ?? (report.verdict === 'errors' ? report.findings.length : 0);
    const warnings =
      report.counts?.['warning'] ?? (report.verdict === 'warnings' ? report.findings.length : 0);
    // Only the findings that actually DRIVE the verdict become "failing items".
    // An allowlisted import is downgraded to `info` by design and is not what
    // failed — listing it anyway pads the renderer's 15-item cap and can push a
    // real error out of view, while its allowlist justification reads like a
    // fix instruction. A fix-list that names non-failures is not a fix-list.
    const driving = report.findings.filter((f) =>
      report.verdict === 'errors' ? f.severity === 'error' : f.severity === 'warning',
    );
    gates.push({
      name: 'imports',
      status: report.verdict === 'errors' ? 'fail' : 'pass',
      detail: `verdict=${report.verdict} (${driving.length} of ${report.findings.length} finding(s) drive it) across ${hygieneFiles.length} changed source file(s)`,
      errors,
      warnings,
      // THE hygiene coverage fold: an unreadable changed source was never
      // checked, so a clean result over it settles this sub-gate `partial` (2).
      coverage: importHygieneCoverage(report, 'changed source files'),
      items: driving.map((f) => ({
        file: f.file,
        line: f.line,
        message: `[${f.severity}] ${f.kind}: ${f.suggestedFix || f.reason || f.snippet}`.trim(),
      })),
    });
  }

  // ── wiring + policy (changed-only, from resolved config) ─────────────
  const loaded = await resolveProjectConfig(cwd);
  let configError: string | undefined;
  if (!loaded.ok) {
    // A MALFORMED config in a real sharkcraft project is a fail (the wiring/
    // policy gates can't be trusted). The mere ABSENCE of a sharkcraft/ folder
    // is not — those gates simply don't apply, so skip them without failing.
    // THE "no config at all" answer (`isProjectConfigAbsent`: the loader found
    // no sharkcraft/ folder) — the quality report's plane row reads it too.
    const isSharkcraftProject = !isProjectConfigAbsent(loaded.error);
    if (isSharkcraftProject) configError = loaded.error.message;
    const detail = isSharkcraftProject
      ? `config did not load: ${loaded.error.message}`
      : 'no sharkcraft config (gate not applicable)';
    gates.push(skip('wiring', detail));
    gates.push(skip('unprovided', detail));
    gates.push(skip('policy', detail));
  } else {
    // Every plane sub-gate walks THE plane scan scope (`planeScanExcludeDirs`),
    // the same tree its verb (`check wiring`, `wiring unprovided`,
    // `policy-lint`) walks for the same rule.
    const excludeDirs = planeScanExcludeDirs(cwd, loaded.value.sharkcraftDir);
    // A pack rule the merge seam rejected never runs, whatever changed: its
    // sub-gate FAILS naming it, as `gates check` fails the same errored row
    // (round 12 review, R12-X1) — never a "Safe to finish" over a rule that
    // was silently dropped.
    const rejected = seamRejectedRules(loaded.value, ['wiring', 'registration', 'policy']);
    const rejectedOn = (plane: 'wiring' | 'registration' | 'policy'): IGateRuleResult[] =>
      rejected.filter((r) => r.type === plane);
    gates.push(
      withSeamRejections(
        wiringGate(cwd, loaded.value.config.wiringRules ?? [], changedFiles, excludeDirs),
        rejectedOn('wiring'),
      ),
      withSeamRejections(
        unprovidedGate(cwd, loaded.value.config.registrationGraph ?? [], changedFiles, excludeDirs, baseRefFor(input)),
        rejectedOn('registration'),
      ),
      withSeamRejections(
        policyGate(cwd, loaded.value.config.policyRules ?? [], changedFiles, excludeDirs),
        rejectedOn('policy'),
      ),
    );
  }

  // ── deleted-orphans (write-safety) ───────────────────────────────────
  gates.push(await orphansGate(input));

  // ── architecture (advisory): cycles the change participates in ───────
  gates.push(await archGate(cwd, changedFiles));

  // ── impact summary (informational, best-effort) ──────────────────────
  const impact = await impactSummary(cwd, changedFiles);

  // ── settle each sub-gate's reported status, once ─────────────────────
  // A `pass` whose coverage has a shortfall is `partial` — derived HERE, so the
  // text renderer and --json show the same word and the fold below reads it.
  const settledGates = gates.map(settleFinishGate);

  // ── fold into one honest 0/1/2 verdict — through the shared envelope ──
  // Only NON-advisory ("deciding") gates decide the verdict, and only the ones
  // that evaluated something become rows: a skipped sub-gate is narrowing (its
  // domain had nothing in the changeset), not a gap. The envelope settles the
  // proposal on every row's coverage and on the run's — so a partial gate is 2,
  // and a run where NO deciding gate evaluated anything (run coverage expected
  // 0) is 2 unless `--allow-empty` accepted it. A deciding fail (or a config
  // that could not load) is 1.
  const deciding = settledGates.filter((g) => !g.advisory);
  const evaluatedDeciding = deciding.filter((g) => g.status !== 'skipped');
  const failed = deciding.filter((g) => g.status === 'fail');
  const rows: IGateRuleResult[] = evaluatedDeciding.flatMap((g): IGateRuleResult[] => [
    {
      id: g.name,
      type: 'finish',
      // A settled `partial` is handed over as `passed` with its coverage: the
      // builder re-derives `partial` through the same core `settleRuleStatus`.
      status: g.status === 'fail' ? 'failed' : 'passed',
      severity: 'error',
      counts: { errors: g.errors, warnings: g.warnings },
      violations: g.items.slice(0, 50).map((i) => ({
        id: i.message,
        ...(i.file ? { file: i.file } : {}),
        ...(i.line !== undefined ? { line: i.line } : {}),
      })),
      coverage: g.coverage ?? { unit: `${g.name} sub-gate runs`, expected: 1, examined: 1 },
    },
    // A sub-gate's further records (round 13 review: the unprovided sub-gate's
    // other idioms' role records and acceptances) — each its own row, so the
    // one settle names every gap and prints every acceptance.
    ...(g.extraCoverage ?? []).map(
      (c, i): IGateRuleResult => ({
        id: `${g.name}: ${c.subject ?? `record ${i + 2}`}${c.acceptedBy !== undefined ? ' (accepted)' : ''}`,
        type: 'finish',
        status: 'passed',
        severity: 'error',
        counts: {},
        violations: [],
        coverage: c,
      }),
    ),
  ]);
  if (configError) {
    rows.push({
      id: 'config',
      type: 'finish',
      status: 'error',
      severity: 'error',
      counts: {},
      violations: [],
      error: `sharkcraft.config.ts did not load: ${configError}`,
      coverage: { unit: 'config files', expected: 1, examined: 0, reason: 'failed to load' },
    });
  }
  const runCoverage: IVerdictCoverage = {
    unit: 'deciding sub-gates',
    expected: evaluatedDeciding.length,
    examined: evaluatedDeciding.length,
    ...(evaluatedDeciding.length === 0
      ? {
          reason:
            changedFiles.length === 0
              ? 'nothing changed'
              : 'no deciding gate had anything in the changed scope to evaluate',
        }
      : {}),
    ...(input.emptyValve ? input.emptyValve(evaluatedDeciding.length) : {}),
  };
  const proposed = failed.length > 0 || configError ? ExitCode.Failure : ExitCode.VerifiedPass;
  const gate = buildGateEnvelope('finish', proposed, rows, runCoverage);
  const exit = gate.exit as ExitCode;
  const verdict: IFinishReport['verdict'] =
    gate.verdict === 'pass' ? 'pass' : gate.verdict === 'fail' ? 'fail' : 'not-verified';

  const anyEvaluated = evaluatedDeciding.length > 0;
  const warnings = settledGates.reduce((n, g) => n + g.warnings, 0);
  const skipped = settledGates.filter((g) => g.status === 'skipped').map((g) => g.name);
  const advisoryWarned = settledGates.filter((g) => g.advisory && g.warnings > 0).map((g) => g.name);
  const gateShortfalls = gate.shortfalls;
  const summary =
    verdict === 'fail'
      ? `Not safe to finish: ${configError ? 'config failed to load; ' : ''}${failed.map((g) => `${g.name} (${g.errors} error(s))`).join(', ') || 'see gates'}.`
      : verdict === 'not-verified' && anyEvaluated
        ? `Not verified: ${gateShortfalls.slice(0, 3).join('; ')}${gateShortfalls.length > 3 ? `; … (+${gateShortfalls.length - 3} more)` : ''} — this is NOT a pass.`
        : verdict === 'not-verified'
          ? `Not verified: no gate evaluated the changed scope${changedFiles.length === 0 ? ' (nothing changed)' : ' (nothing in it is gate-relevant)'} — this is NOT a pass. Re-run over a scope with code changes, or gate explicitly.`
          : !anyEvaluated
            ? 'Nothing to finish: no deciding gate had anything to evaluate — accepted explicitly.'
            : `Safe to finish: every applicable gate passed${warnings > 0 ? ` (${warnings} non-blocking warning(s)${advisoryWarned.length > 0 ? ` — see ${advisoryWarned.join(', ')}` : ''})` : ''}${skipped.length > 0 ? `; skipped: ${skipped.join(', ')}` : ''}.`;
  const nextAction =
    verdict === 'fail'
      ? 'Fix every failing gate item (each carries file:line), then re-run `shrk finish`.'
      : verdict === 'not-verified'
        ? anyEvaluated
          ? 'Part of the changed scope was not verified (see "Not verified" above) — do not treat this as done.'
          : 'Nothing was verified — do not treat this as done.'
        : anyEvaluated
          ? 'Safe to declare done.'
          : 'Nothing was gated — the empty changeset was accepted with --allow-empty.';

  return {
    schema: FINISH_SCHEMA,
    scope: { mode: input.mode, files: changedFiles, fileCount: changedFiles.length },
    gates: settledGates,
    impact,
    verdict,
    exit,
    warnings,
    ...(configError ? { configError } : {}),
    summary,
    nextAction,
    gate,
  };
}

function skip(name: IFinishGate['name'], detail: string): IFinishGate {
  return { name, status: 'skipped', detail, errors: 0, warnings: 0, items: [] };
}

/** A skipped ADVISORY gate — reports its detail but never decides the verdict. */
function advisorySkip(name: IFinishGate['name'], detail: string): IFinishGate {
  return { name, status: 'skipped', detail, errors: 0, warnings: 0, items: [], advisory: true };
}

/**
 * A plane sub-gate with the pack rules the merge seam REJECTED folded in: each
 * is a failing item (it never ran), so the sub-gate fails — skipped or not —
 * exactly as `gates check` fails the same errored rows (round 12 review,
 * R12-X1). Unchanged when there are none.
 */
function withSeamRejections(gate: IFinishGate, rejected: readonly IGateRuleResult[]): IFinishGate {
  if (rejected.length === 0) return gate;
  const note = `${rejected.length} pack rule(s) rejected at the pack-plane merge seam — NOT evaluated`;
  return {
    ...gate,
    status: 'fail',
    detail: gate.status === 'skipped' ? note : `${gate.detail}, ${note}`,
    errors: gate.errors + rejected.length,
    items: [
      ...gate.items,
      ...rejected.map((r) => ({ message: `rejected pack rule ${r.id}: ${r.error ?? 'failed validation'}` })),
    ],
  };
}

/**
 * One sub-gate's coverage over the rules its changeset SELECTED, folded from
 * each rule's ENGINE coverage through core's `coverageShortfall` — the rule
 * `check wiring --changed-only` / `policy-lint --changed-only` / `check
 * boundaries --changed-only` settle their exit on — so a rule that passed over
 * part of its scope, or examined nothing at all, is unexamined here exactly as
 * those verbs count it. Returns the record and the ` — NOT VERIFIED: <rule>:
 * <shortfall>` detail suffix. `diff-check` folds its boundaries row with it too.
 */
export function ruleSetCoverage(
  unit: string,
  rules: readonly { readonly ruleId: string; readonly coverage: IVerdictCoverage }[],
  reason: string,
): { readonly coverage: IVerdictCoverage; readonly notVerified: string } {
  const ruleShortfalls = rules.flatMap((r) => {
    const s = coverageShortfall(r.coverage);
    return s === undefined ? [] : [{ id: r.ruleId, shortfall: s }];
  });
  const coverage: IVerdictCoverage = {
    unit,
    expected: rules.length,
    examined: rules.length - ruleShortfalls.length,
    ...(ruleShortfalls.length > 0
      ? {
          unexamined: ruleShortfalls.slice(0, 20).map((r) => r.id),
          unexaminedTotal: ruleShortfalls.length,
          reason,
        }
      : {}),
  };
  const first = ruleShortfalls[0];
  const notVerified = first
    ? ` — NOT VERIFIED: ${first.id}: ${first.shortfall}${ruleShortfalls.length > 1 ? ` (+${ruleShortfalls.length - 1} more)` : ''}`
    : '';
  return { coverage, notVerified };
}

/** A rule that matched nothing under `failOnEmpty`, as a sub-gate item. */
function emptyFailureItem(s: {
  readonly ruleId: string;
  readonly reason: string;
  readonly severity: string;
}): IFinishItem {
  return { message: `[${s.severity}] ${s.ruleId}: matched nothing (failOnEmpty) — ${s.reason}` };
}

/**
 * The boundaries sub-gate — through THE boundary orchestrator, the call `check
 * boundaries --changed-only`, `diff-check` and the MCP tools make (round 11).
 *
 * It closes the two greens closing#d reproduced:
 *   - a rule EDIT (the changeset touches a rule source, the config or
 *     tsconfig) escalates those rules to a whole-tree evaluation: the
 *     violations the edit created in untouched files are this changeset's,
 *     never "legacy";
 *   - a change no rule GOVERNS evaluated nothing, so the gate SKIPS — it used to
 *     report `pass` from an error count of zero over files no rule looks at.
 * Otherwise it carries the selected rules' coverage, so a rule whose scope glob
 * went dead settles it `partial`.
 */
function boundariesGate(
  inspection: ISharkcraftInspection,
  changed: { readonly mode: ChangedScopeMode; readonly files: readonly string[] },
): IFinishGate {
  const loadIssues = inspection.boundaryLoadIssues ?? [];
  if (inspection.boundaryRegistry.size() === 0 && loadIssues.length === 0) {
    const why = describeBoundaryConfiguration(inspection).diagnostics[0];
    return skip('boundaries', `no boundary rules configured${why ? ` — ${why}` : ''}`);
  }
  if (changed.files.length === 0 && loadIssues.length === 0) {
    return skip('boundaries', 'nothing in the changed scope');
  }
  const r = runBoundaryCheck(inspection, { changed });
  if (r.selectedRuleIds.length === 0 && r.loadIssues.length === 0) {
    return skip(
      'boundaries',
      `no changed source file is governed by a boundary rule (${changed.files.length} changed file(s))`,
    );
  }
  const errors = r.violations.filter((v) => v.severity === 'error');
  const warnings = r.violations.filter((v) => v.severity === 'warning');
  const failedOnEmpty = r.rules.filter((x) => x.failedOnEmpty === true);
  const escalated = r.changed?.escalatedRuleIds ?? [];
  const governed = r.changed?.governedFiles.length ?? 0;
  const { coverage, notVerified } = ruleSetCoverage(
    'boundary rules',
    r.rules.map((x) => ({ ruleId: x.ruleId, coverage: x.coverage })),
    'passed over part of their scope or checked nothing',
  );
  const detailParts = [
    `${errors.length} error(s), ${warnings.length} warning(s) across ${governed} governed changed file(s)`,
  ];
  if (escalated.length > 0) {
    const why = [...new Set(r.changed?.escalation.reasons.map((x) => x.file) ?? [])].join(', ');
    detailParts.push(`${escalated.length} rule(s) escalated (${why} changed) — evaluated repo-wide`);
  }
  if (r.loadIssues.length > 0) detailParts.push(`${r.loadIssues.length} errored rule(s)`);
  if (r.staleExceptions.length > 0) detailParts.push(`${r.staleExceptions.length} stale exception(s)`);
  if (failedOnEmpty.length > 0) detailParts.push(`${failedOnEmpty.length} matched nothing (failOnEmpty)`);
  // Round 13 (lane B): dead selector units and went-live expectEmpty markers
  // are ADVISORY on finish — named in the detail and listed in `notes`, never
  // items (items are the envelope's violations) and never a failure: finish
  // runs without --fail-on-dead-units. It used to report `pass` in silence
  // while `check boundaries` withheld its ✓ over the same tree.
  // A PACK marker that went live is INFO (round 13 review) — `check
  // boundaries` prints it in its own INFO block; it never counts as advisory.
  const advisory = [
    ...r.deadUnits.map((d) => `[advisory] dead selector unit [${d.unit}] ${d.ruleId}: ${d.selector} — ${d.reason}`),
    ...r.wentLive.map(
      (u) => `${u.packageName !== undefined ? '[info]' : '[advisory]'} [${u.unit}] ${u.ruleId}: ${u.selector} — ${u.reason}`,
    ),
  ];
  const localWentLive = r.wentLive.filter((u) => u.packageName === undefined).length;
  const packWentLive = r.wentLive.length - localWentLive;
  // Each rule's expectEmpty acceptance (settle record B) — its own envelope row
  // through `extraCoverage`, so finish's ONE settle prints every acceptance at
  // exit 0 (round 13 review: they were dropped in silence — the sub-gate's
  // single `coverage` is the rule-set fold, which cannot carry them).
  const acceptances: IVerdictCoverage[] = r.rules.flatMap((x) =>
    x.detail.unitAcceptance !== undefined
      ? [{ ...x.detail.unitAcceptance, subject: x.detail.unitAcceptance.subject ?? x.ruleId }]
      : [],
  );
  if (r.deadUnits.length > 0) detailParts.push(`${r.deadUnits.length} dead selector unit(s) (advisory)`);
  if (localWentLive > 0) detailParts.push(`${localWentLive} expectEmpty marker(s) went live (advisory)`);
  if (packWentLive > 0) detailParts.push(`${packWentLive} pack expectEmpty marker(s) went live (INFO)`);
  if (r.intendedEmpty.length > 0) detailParts.push(`${r.intendedEmpty.length} expectEmpty unit(s) intended empty`);
  return {
    name: 'boundaries',
    // The orchestrator's proposal is THE boundary verdict: 1 = something failed.
    status: r.proposedExit === ExitCode.Failure ? 'fail' : 'pass',
    detail: `${detailParts.join('; ')}${notVerified}`,
    errors: errors.length + r.loadIssues.length + r.staleExceptions.length + failedOnEmpty.length,
    warnings: warnings.length,
    coverage,
    ...(acceptances.length > 0 ? { extraCoverage: acceptances } : {}),
    ...(advisory.length > 0 ? { notes: advisory } : {}),
    items: [
      ...[...errors, ...warnings].map((v) => ({
        file: v.file,
        line: v.line,
        message: `[${v.severity}] ${v.ruleId}: ${v.message}`,
      })),
      ...r.loadIssues.map((i) => ({
        file: i.file,
        message: `[error] ${i.ruleId ?? i.kind}: ${i.issues.join('; ')} — NOT evaluated`,
      })),
      ...r.staleExceptions.map((s) => ({ file: s.file, message: `[error] ${s.ruleId}: ${s.message}` })),
      ...failedOnEmpty.map((x) =>
        emptyFailureItem({ ruleId: x.ruleId, reason: x.skipReason ?? 'no governed file', severity: x.severity }),
      ),
    ],
  };
}

/**
 * A plane sub-gate's per-rule expectEmpty acceptances and unit notes (round 13
 * review): the acceptances ride beside the rule-set fold as `extraCoverage`
 * (one envelope row each, as the boundaries sub-gate does), so finish's ONE
 * settle prints every one at exit 0 — `check wiring` / `policy-lint` printed
 * them while finish dropped them in silence. A dead glob of a rule that still
 * matched and a LOCAL marker whose target appeared are ADVISORY notes; a pack
 * marker is `[info]` — worded by THE shared unit-state renderer. Never a
 * failure: finish runs without --fail-on-dead-units.
 */
function planeUnitFields(
  rules: readonly {
    readonly ruleId: string;
    readonly unitAcceptance?: IVerdictCoverage;
    readonly unitLiveness?: readonly IUnitLiveness[];
  }[],
  emptyIds: ReadonlySet<string>,
): Pick<IFinishGate, 'extraCoverage' | 'notes'> {
  const extra: IVerdictCoverage[] = rules.flatMap((r) =>
    r.unitAcceptance !== undefined ? [{ ...r.unitAcceptance, subject: r.unitAcceptance.subject ?? r.ruleId }] : [],
  );
  const n = unitStateNotes(
    rules.map((r) => ({
      id: r.ruleId,
      ...(r.unitLiveness !== undefined ? { unitLiveness: r.unitLiveness } : {}),
      reportedEmpty: emptyIds.has(r.ruleId),
    })),
  );
  const notes = [
    ...n.deadLines.map((l) => `[advisory] dead selector unit ${l} — ${DEAD_SELECTOR_CAUSES}`),
    ...n.localWentLiveLines.map((l) => `[advisory] ${l}`),
    ...n.packWentLiveLines.map((l) => `[info] ${l}`),
  ];
  return { ...(extra.length > 0 ? { extraCoverage: extra } : {}), ...(notes.length > 0 ? { notes } : {}) };
}

function wiringGate(
  cwd: string,
  rules: readonly IWiringRule[],
  changedFiles: readonly string[],
  excludeDirs: readonly string[],
): IFinishGate {
  if (rules.length === 0) return skip('wiring', 'no wiring rules configured');
  const report = runWiring(cwd, rules, { changedOnly: true, changedFiles, excludeDirs });
  // Skip ONLY when the changeset selected no rule (no rule's footprint
  // intersects it) — deliberate narrowing. A SELECTED rule that examined
  // nothing (its source globs matched no files) is not narrowing: it falls
  // through, carries its coverage, and settles this sub-gate `partial` (2) or
  // `fail` (1, an error-severity failOnEmpty rule) — exactly where `check
  // wiring --changed-only` reads 2 / 1. (Skipping on `evaluated === 0` read
  // "Safe to finish", exit 0, over a rule that had checked nothing.)
  if (report.rules.length === 0) {
    return skip('wiring', `${rules.length} rule(s) configured, none in the changed scope`);
  }
  const errors = report.violations.filter((v) => v.severity === 'error');
  const warnings = report.violations.filter((v) => v.severity === 'warning');
  // A misconfigured rule (bad regex / no capture group) yields a diagnostic +
  // rule-level error but NO violation — it must FAIL the gate, never read as a
  // silent green ("loud, never silent green").
  const diag = report.diagnostics;
  // A rule that matched nothing under failOnEmpty carries no violation either:
  // it is counted and listed so a failing sub-gate names what failed.
  const emptyFailed = report.skipped.filter((s) => s.failed);
  // Round 11: what this sub-gate examined — every selected rule's engine
  // coverage through core's shortfall rule, so a rule that passed over part of
  // its scope (a subset rule whose declared selector never produced some
  // registered tokens) or checked nothing keeps this sub-gate from counting as
  // a pass (the settle step reports it `partial` and the composite is 2).
  const { coverage, notVerified } = ruleSetCoverage(
    'wiring rules',
    report.rules,
    'passed over part of their scope or checked nothing',
  );
  return {
    ...planeUnitFields(report.rules, new Set(report.skipped.map((s) => s.ruleId))),
    name: 'wiring',
    status: report.verdict === 'errors' || diag.length > 0 ? 'fail' : 'pass',
    detail: `${report.evaluated}/${report.rules.length} rule(s) evaluated — ${errors.length} error(s), ${warnings.length} warning(s)${diag.length > 0 ? `, ${diag.length} misconfigured` : ''}${emptyFailed.length > 0 ? `, ${emptyFailed.length} matched nothing (failOnEmpty)` : ''}${notVerified}`,
    errors: errors.length + diag.length + emptyFailed.filter((s) => s.severity === 'error').length,
    warnings: warnings.length + emptyFailed.filter((s) => s.severity === 'warning').length,
    coverage,
    items: [
      ...report.violations.map((v) => ({
        file: v.file,
        line: v.line,
        message: `[${v.severity}] ${v.ruleId}: "${v.token}" ${v.direction === 'registered-missing' ? 'registered but not declared' : 'declared but not registered'}`,
      })),
      ...diag.map((d) => ({ message: `misconfigured rule: ${d}` })),
      ...emptyFailed.map(emptyFailureItem),
    ],
  };
}

function policyGate(
  cwd: string,
  rules: readonly IPolicyRule[],
  changedFiles: readonly string[],
  excludeDirs: readonly string[],
): IFinishGate {
  if (rules.length === 0) return skip('policy', 'no policy rules configured');
  // The SharkCraft asset dir holds the rule definitions themselves (which can
  // self-match): pruned through THE plane scan scope, exactly as `policy-lint`.
  const report = runPolicyLint(cwd, rules, { changedOnly: true, changedFiles, excludeDirs });
  // Same shape as the wiring sub-gate: skip ONLY when no rule is in the
  // changed scope. The engine already narrows a rule out when the change put
  // no content in front of it (only deleted files, or files with nothing on its
  // surface), so a rule still SELECTED here that scanned nothing left real
  // scope unexamined: it settles this sub-gate `partial` (2), or `fail` (1)
  // under failOnEmpty — exactly where `policy-lint --changed-only` reads 2 / 1.
  if (report.rules.length === 0) {
    return skip('policy', `${rules.length} rule(s) configured, none with content in the changed scope`);
  }
  const errors = report.findings.filter((f) => f.severity === 'error');
  const warnings = report.findings.filter((f) => f.severity === 'warning');
  const diag = report.diagnostics;
  // `policy-lint` fails on ANY failOnEmpty skip (its proposed exit is 1), so
  // this sub-gate fails on one too, and counts it as an error.
  const emptyFailed = report.skipped.filter((s) => s.failed);
  const { coverage, notVerified } = ruleSetCoverage(
    'policy rules',
    report.rules,
    'examined only part of their scope, scanned nothing, or could not run',
  );
  return {
    ...planeUnitFields(report.rules, new Set(report.skipped.map((s) => s.ruleId))),
    name: 'policy',
    status: report.verdict === 'errors' || diag.length > 0 || emptyFailed.length > 0 ? 'fail' : 'pass',
    detail: `${report.evaluated}/${report.rules.length} rule(s) evaluated — ${errors.length} error(s), ${warnings.length} warning(s)${diag.length > 0 ? `, ${diag.length} misconfigured` : ''}${emptyFailed.length > 0 ? `, ${emptyFailed.length} matched nothing (failOnEmpty)` : ''}${notVerified}`,
    errors: errors.length + diag.length + emptyFailed.length,
    warnings: warnings.length,
    coverage,
    items: [
      ...report.findings.map((f) => ({
        file: f.file,
        line: f.line,
        message: `[${f.severity}] ${f.ruleId}: ${f.message ?? ''}`.trim(),
      })),
      ...diag.map((d) => ({ message: `misconfigured rule: ${d}` })),
      ...emptyFailed.map(emptyFailureItem),
    ],
  };
}

/**
 * The runtime-wiring `unprovided` gate — the silent-at-runtime class imports
 * can't see: a token DECLARED or INJECTED but never PROVIDED (typecheck-green,
 * absent at runtime). Backed by the registration/DI graph, scoped to the
 * changeset so only tokens THIS change touches decide the verdict. Skips (never
 * fails) when no idioms are configured or the change touched no wiring — so a
 * repo that never modeled its DI is not penalized.
 */
function unprovidedGate(
  cwd: string,
  idioms: readonly IRegistrationIdiom[],
  changedFiles: readonly string[],
  excludeDirs: readonly string[],
  baseRef?: string,
): IFinishGate {
  if (idioms.length === 0) return skip('unprovided', 'no registration idioms configured');
  const graph = buildRegistrationGraph(cwd, idioms, { excludeDirs });
  const diag = graph.diagnostics;

  // Two ways THIS change can leave a token unprovided:
  //  (1) a declared/injected site added in a changed file with no provider —
  //      caught by scoping the graph query to the changed files;
  //  (2) the last PROVIDER removed from a changed file — which leaves NO site in
  //      the changed file, so (1) structurally can't see it. Recover it by
  //      diffing the base content of the changed files (providerRegressions).
  const regressions = baseRef ? providerRegressions(cwd, idioms, graph, changedFiles, baseRef) : [];
  // Settled against what the graph READ, through the one boundaries helper
  // `wiring unprovided` and MCP `get_wiring_graph` use. A file an idiom
  // matched that the reader could not read (over the read cap) holds sites the
  // graph never saw: a token whose provider could sit there is `unproven` —
  // not a failure, and never a pass (its coverage names the token and file).
  // Round 13 (P4): and against what every idiom's ROLES examined, from THE
  // role authority `gates check` reads — a declared role that matched no file
  // printed `✓ unprovided pass` here while `gates check` said NOT VERIFIED.
  const verdict = registrationUnprovidedVerdict(
    graph,
    idioms,
    measureIdiomRoleCoverage(cwd, idioms, excludeDirs),
    changedFiles,
    regressions,
  );
  const unprovided = verdict.findings;
  const candidates = unprovided.length + verdict.unproven.length;

  // A CHANGED unread file is scope this change put in front of the gate, so it
  // keeps the gate from skipping — so does a changed file beneath a directory
  // the reader could not list.
  const unreadChanged = (graph.readScope?.unread ?? []).filter(
    (u) => changedFiles.includes(u.path) || changedFiles.some((f) => unreadDirectoryContains(u, f)),
  );

  // Skip (evaluated nothing) only when the change touched no registration site
  // AND removed no provider AND has no misconfigured idiom — never a silent pass.
  if (
    !registrationTouchesChanged(graph, changedFiles) &&
    candidates === 0 &&
    diag.length === 0 &&
    unreadChanged.length === 0
  ) {
    return skip('unprovided', 'no registration sites in the changed scope');
  }
  // The most specific record: the demoted tokens (their reason names the
  // unread file), else the first record with a gap — the unread idiom files,
  // or an idiom role that examined nothing (round 13, P4) — else an
  // expectEmpty acceptance (printed at 0), else the first. A full record
  // picked over a gap would settle `pass` over a dead role.
  const coverage =
    verdict.coverage.find((c) => c.subject === 'unprovided') ??
    verdict.coverage.find((c) => coverageShortfall(c) !== undefined) ??
    verdict.coverage.find((c) => c.acceptedBy !== undefined) ??
    verdict.coverage[0];
  // Every OTHER record rides beside it (round 13 review) — one per idiom: a
  // second idiom's acceptance or dead role is never dropped.
  const extraCoverage = verdict.coverage.filter((c) => c !== coverage);
  const siteOf = (u: IUnprovidedToken): { file?: string; line?: number } => {
    const site = u.declared[0] ?? u.consumed[0];
    return site ? { file: site.file, line: site.line } : {};
  };
  return {
    name: 'unprovided',
    status: unprovided.length > 0 || diag.length > 0 ? 'fail' : 'pass',
    detail:
      `${unprovided.length} unprovided token(s) attributable to the change` +
      `${verdict.unproven.length > 0 ? `, ${verdict.unproven.length} not verified (a provider may sit in an unread file)` : ''}` +
      `${diag.length > 0 ? `, ${diag.length} misconfigured idiom(s)` : ''}`,
    errors: unprovided.length + diag.length,
    warnings: 0,
    ...(coverage ? { coverage } : {}),
    ...(extraCoverage.length > 0 ? { extraCoverage } : {}),
    items: [
      ...unprovided.map((u) => ({
        ...siteOf(u),
        message: `"${u.token}" declared/injected but never provided (silent at runtime)`,
      })),
      ...verdict.unproven.map((u) => ({
        ...siteOf(u),
        message: `"${u.token}" has no provider among the files read — NOT VERIFIED (a provider may sit in an unread file)`,
      })),
      ...diag.map((d) => ({ message: `misconfigured idiom: ${d}` })),
    ],
  };
}

/**
 * Tokens whose LAST provider this change removed. Reads the base content of each
 * changed code file, extracts what it USED to provide, and keeps any token now
 * provided nowhere in the worktree but still declared/consumed — the runtime
 * break (`inject(T)` → undefined) that deleting a provider registration causes,
 * which leaves no site in the changed file for post-change scoping to catch.
 */
function providerRegressions(
  cwd: string,
  idioms: readonly IRegistrationIdiom[],
  graph: ReturnType<typeof buildRegistrationGraph>,
  changedFiles: readonly string[],
  baseRef: string,
): IUnprovidedToken[] {
  const codeChanged = codeFilesOf(changedFiles);
  if (codeChanged.length === 0) return [];
  const baseEntries: { path: string; content: string }[] = [];
  for (const f of codeChanged) {
    const content = gitShowFile(cwd, baseRef, f);
    if (content !== null) baseEntries.push({ path: f, content });
  }
  if (baseEntries.length === 0) return [];
  const wasProvided = providedTokensFromEntries(idioms, baseEntries);
  const out: IUnprovidedToken[] = [];
  for (const token of wasProvided) {
    const node = graph.tokens.find((t) => t.token === token);
    if (node && node.provided.length === 0 && (node.declared.length > 0 || node.consumed.length > 0)) {
      out.push({ token, declared: node.declared, consumed: node.consumed });
    }
  }
  return out;
}

/**
 * Advisory architecture gate: does any changed file participate in a runtime
 * import cycle? Distinct from the `boundaries` gate (which sees layer violations,
 * not cycles). Deliberately ADVISORY — a pre-existing cycle a change merely
 * touches must not be attributed to this changeset, so it reports as a
 * non-blocking warning and never fails the composite. Type-only import edges are
 * excluded (they erase at emit and can't cause a runtime cycle). Best-effort:
 * a missing graph index degrades to skip, never fail.
 */
async function archGate(cwd: string, changedFiles: readonly string[]): Promise<IFinishGate> {
  const codeChanged = codeFilesOf(changedFiles);
  if (codeChanged.length === 0) return advisorySkip('arch', 'no code files in changed scope');
  try {
    const { GraphStore, GraphQueryApi } = await import('@shrkcrft/graph');
    if (!new GraphStore(cwd).exists()) {
      return advisorySkip('arch', 'code-graph index missing — run `shrk graph index`');
    }
    const api = GraphQueryApi.fromStore(cwd);
    const cycles = api.cycles(); // runtime cycles only (type-only edges excluded)
    const scope = new Set(codeChanged.map((f) => f.replace(/\\/g, '/').replace(/^\.\//, '')));
    const touching = cycles.filter((c) =>
      (c.paths ?? c.nodeIds.map((id) => id.replace(/^file:/, ''))).some((p) => scope.has(p)),
    );
    if (touching.length === 0) {
      return advisorySkip(
        'arch',
        `no changed file participates in an import cycle (${cycles.length} runtime cycle(s) in repo)`,
      );
    }
    return {
      name: 'arch',
      status: 'pass', // advisory: reports cycles as warnings, never fails the composite
      advisory: true,
      detail: `${touching.length} changed file(s) participate in a runtime import cycle (advisory — not attributed to this change)`,
      errors: 0,
      warnings: touching.length,
      items: touching.slice(0, 15).map((c) => {
        const paths = c.paths ?? c.nodeIds.map((id) => id.replace(/^file:/, ''));
        return { message: `import cycle (size ${c.size}): ${paths.join(' → ')}` };
      }),
    };
  } catch (e) {
    return advisorySkip('arch', `arch check unavailable: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function orphansGate(input: IRunFinishInput): Promise<IFinishGate> {
  const opts = orphanOptsFor(input);
  if (!opts) return skip('orphans', 'explicit --files scope has no diff to read deletions from');
  const scan = await computeDeletedOrphans(input.cwd, opts);
  if (!scan.ok) {
    return skip(
      'orphans',
      scan.reason === 'graph-missing'
        ? 'code-graph index missing — run `shrk graph index` to enable the orphan check'
        : `diff unavailable: ${scan.error ?? 'unknown'}`,
    );
  }
  if (scan.deleted.length === 0) return skip('orphans', `nothing deleted (vs ${scan.ref})`);
  // What the orphan query examined — the ONE authority `check orphans` settles
  // on: deleted files the index knows, over an index current for every
  // surviving importer. A delete of nothing the graph indexes (a README, a
  // `dist/*.js`) evaluates nothing here, so the sub-gate skips.
  const coverage = deletedOrphanCoverage(scan);
  if (coverage.expected === 0) return skip('orphans', coverage.reason ?? 'no deleted code files');
  const orphans = scan.report?.orphans ?? [];
  return {
    name: 'orphans',
    status: orphans.length > 0 ? 'fail' : 'pass',
    detail: `${scan.deleted.length} deleted file(s) (vs ${scan.ref}) — ${orphans.length} surviving importer(s)`,
    errors: orphans.length,
    warnings: 0,
    coverage,
    items: orphans.map((o) => ({
      file: o.path ?? o.id,
      ...(typeof o.line === 'number' ? { line: o.line } : {}),
      message:
        o.via === 'reference' && o.symbol
          ? `references \`${o.symbol}\` from deleted ${o.deletedFile}`
          : `imports deleted ${o.deletedFile}`,
    })),
  };
}

async function impactSummary(cwd: string, changedFiles: readonly string[]): Promise<IFinishImpact> {
  if (changedFiles.length === 0) return { ran: false, note: 'no changed files' };
  try {
    const { GraphStore } = await import('@shrkcrft/graph');
    if (!new GraphStore(cwd).exists()) {
      return { ran: false, note: 'code-graph index missing — run `shrk graph index`' };
    }
    const { analyzeGraphImpact } = await import('@shrkcrft/impact-engine');
    const analysis = analyzeGraphImpact(
      { kind: 'files', files: [...changedFiles] },
      { projectRoot: cwd, maxDepth: 5, limit: 200 },
    );
    return {
      ran: true,
      risk: analysis.risk,
      directDependents: analysis.directDependents.length,
      transitiveDependents: analysis.transitiveDependents.length,
    };
  } catch (e) {
    return { ran: false, note: `impact summary unavailable: ${e instanceof Error ? e.message : String(e)}` };
  }
}
