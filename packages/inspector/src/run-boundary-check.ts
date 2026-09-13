import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  ruleVerdictRecords,
  selectorUnitFails,
  settleVerdict,
  UnitLivenessState,
  type ISelectorUnitFailOptions,
  type IVerdictCoverage,
} from '@shrkcrft/core';
import {
  boundaryRuleScope,
  boundaryScopeCoversUnread,
  boundaryScopeDecision,
  boundaryUnitFinding,
  evaluateBoundaries,
  isUnreadDirectory,
  loadTsconfigPaths,
  nodeBuiltinPackageNames,
  readScopeCoverage,
  scanImports,
  unreadDirectoryContains,
  UnreadFileReason,
  type IBoundaryRule,
  type IBoundaryRuleCoverage,
  type IBoundaryUnitFinding,
  type IBoundaryViolation,
  type IEvaluateOptions,
  type IImportScanResult,
  type IUnreadFile,
} from '@shrkcrft/boundaries';
import {
  filterViolationsToChangedScope,
  resolveChangedFiles,
} from './boundaries-changed-only.ts';
import type { IRunBoundaryCheckOptions } from './boundary-check-options.model.ts';
import type { IBoundaryCheckResult } from './boundary-check-result.model.ts';
import { boundaryFileLabel, describeBoundaryConfiguration } from './boundary-configuration-status.ts';
import type { IBoundaryLoadIssue } from './boundary-load-issue.model.ts';
import type { IBoundaryRuleCheck } from './boundary-rule-check.model.ts';
import type { IBoundaryRuleInvalidation } from './boundary-rule-invalidation.model.ts';
import type { IBoundaryRuleSetDiff } from './boundary-rule-set-diff.model.ts';
import { resolveBoundaryRuleInvalidation } from './boundary-rule-sources.ts';
import type { IBoundaryStaleExceptionFinding } from './boundary-stale-exception-finding.model.ts';
import { boundaryUnitLiveness } from './boundary-unit-liveness.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

/**
 * THE boundary orchestrator (round 11, C#one-boundary-check-authority).
 *
 * `check boundaries`, finish's boundaries gate, `diff-check`, quality and both
 * MCP boundary tools used to hand-assemble scan + evaluate each — and they
 * disagreed: the MCP tools never loaded the tsconfig alias map, so an
 * alias-resolved violation the CLI reported was invisible to an agent. This is
 * now the only place that:
 *
 *   - loads tsconfig paths and builds the known-package list;
 *   - runs scanImports + evaluateBoundaries;
 *   - applies the changed-scope filter WITH rule escalation (a rule edit's
 *     violations are never filed as "legacy");
 *   - turns load issues into errored rules and stale exceptions into findings;
 *   - re-settles every rule over what could not be read (`boundaryUnitLiveness`);
 *   - computes the proposed 0/1/2/3 exit and its coverage, and settles it.
 *
 * The CLI builds its gate envelope from `proposedExit` + the coverage records
 * here (and adds its own `--allow-empty` valve). Both sides settle with core's
 * `settleVerdict` — ONE fold, not a copy per layer — and
 * `r75-boundary-parity.test.ts` asserts the envelope's exit equals `exitCode`.
 */
export function runBoundaryCheck(
  inspection: ISharkcraftInspection,
  options: IRunBoundaryCheckOptions = {},
): IBoundaryCheckResult {
  const projectRoot = inspection.projectRoot;
  const ruleFile = options.ruleFile;
  const sourceRules: readonly IBoundaryRule[] = ruleFile ? ruleFile.rules : inspection.boundaryRegistry.list();
  const loadIssues: IBoundaryLoadIssue[] = ruleFile
    ? [...(ruleFile.loadIssues ?? [])]
    : [...(inspection.boundaryLoadIssues ?? [])];
  const configuration = ruleFile ? undefined : describeBoundaryConfiguration(inspection);
  const ruleSource: IBoundaryCheckResult['ruleSource'] = ruleFile
    ? { kind: 'rule-file', path: ruleFile.path }
    : { kind: 'registry' };

  if (options.onlyRuleId !== undefined && !sourceRules.some((r) => r.id === options.onlyRuleId)) {
    // A typo'd `--rule` used to narrow the run to zero rules and report a
    // confident pass over nothing. The request itself is malformed: 3.
    const scan: IImportScanResult = { filesScanned: 0, edges: [], warnings: [], files: [], manifestFiles: [] };
    const runCoverage: IVerdictCoverage = {
      unit: 'rules',
      expected: 0,
      examined: 0,
      reason: `no boundary rule "${options.onlyRuleId}"`,
      root: projectRoot,
    };
    return {
      schema: 'sharkcraft.boundary-check/v1',
      projectRoot,
      ruleSource,
      rulesConfigured: sourceRules.length,
      selectedRuleIds: [],
      scan,
      evaluation: evaluateBoundaries(scan, []),
      rules: [],
      violations: [],
      counts: { error: 0, warning: 0, info: 0 },
      suppressed: [],
      staleExceptions: [],
      deadUnits: [],
      intendedEmpty: [],
      wentLive: [],
      failingUnits: [],
      loadIssues,
      ...(configuration ? { configuration } : {}),
      runCoverage,
      proposedExit: 3,
      exitCode: 3,
      verdict: 'usage-error',
      shortfalls: [],
      accepted: [],
      unknownRuleId: options.onlyRuleId,
      availableRuleIds: sourceRules.map((r) => r.id),
    };
  }

  const rules = options.onlyRuleId ? sourceRules.filter((r) => r.id === options.onlyRuleId) : [...sourceRules];
  const scan = options.scan ?? scanImports({ projectRoot, includeComments: options.includeComments === true });
  const evaluation = evaluateBoundaries(scan, rules, evaluateOptionsFor(projectRoot, scan));
  const detailById = new Map(evaluation.coverage.map((c) => [c.ruleId, c]));
  const sourceFileOf = (ruleId: string): string => {
    if (ruleFile) return boundaryFileLabel(projectRoot, ruleFile.path);
    const src = inspection.boundarySources.get(ruleId);
    return src?.file ? boundaryFileLabel(projectRoot, src.file) : '(unknown rule source)';
  };
  const staleAll: IBoundaryStaleExceptionFinding[] = evaluation.staleExceptions.map((s) => ({
    ...s,
    file: sourceFileOf(s.ruleId),
  }));

  let selected: IBoundaryRule[] = rules;
  let reported: IBoundaryViolation[] = evaluation.violations;
  let reportedStale = staleAll;
  let escalatedIds = new Set<string>();
  let changed: IBoundaryCheckResult['changed'];
  let suppressedEscalation: string[] = [];
  let inReportedScope = (_file: string, _ruleId: string): boolean => true;
  // The files the scan READ, and the ones it matched but could not read. An
  // unread file is in front of every rule whose scope it is in — it is never
  // narrowing, and never "matched nothing".
  const scanned = new Set(scan.files ?? scan.edges.map((e) => e.from));
  const unreadAll: readonly IUnreadFile[] = scan.unread ?? [];
  const unreadPaths = new Set(unreadAll.map((u) => u.path));
  // A directory the scan could not LIST hides every file beneath it: a path
  // under one was never read either (round 11 review R12-GAP-1).
  const unlistedDirs = unreadAll.filter(isUnreadDirectory);
  const beneathUnlisted = (f: string): boolean => unlistedDirs.some((d) => unreadDirectoryContains(d, f));

  if (options.changedScope || options.changed) {
    const resolved = options.changed ?? resolveChangedFiles(options.changedScope!);
    const changedFiles = resolved.files.map((f) => f.split(/[\\/]/).join('/').replace(/^\.\//, ''));
    const changedSet = new Set(changedFiles);
    const ids = rules.map((r) => r.id);
    const invalidation: IBoundaryRuleInvalidation = ruleFile
      ? {
          escalatedRuleIds: ids,
          reasons: [{ file: boundaryFileLabel(projectRoot, ruleFile.path), kind: 'rule-file', ruleIds: ids }],
        }
      : resolveBoundaryRuleInvalidation(changedFiles, inspection, ids);
    if (options.escalate === false) suppressedEscalation = [...invalidation.escalatedRuleIds];
    else escalatedIds = new Set(invalidation.escalatedRuleIds);

    // A rule is accountable to this changeset when it GOVERNS a changed source
    // file — one the scan read, or one it matched and could NOT read (a loud
    // skip, never narrowing). A deleted file, or a doc, put nothing in front of
    // any rule, exactly as the policy plane narrows a pure delete.
    const governedFiles = new Set<string>();
    const governing = new Set<string>();
    for (const rule of rules) {
      const scope = boundaryRuleScope(rule);
      for (const f of changedFiles) {
        if ((scanned.has(f) || unreadPaths.has(f) || beneathUnlisted(f)) && boundaryScopeDecision(scope, f) === 'in') {
          governedFiles.add(f);
          governing.add(rule.id);
        }
      }
    }
    const filtered = filterViolationsToChangedScope(
      evaluation.violations,
      options.changedScope ?? { projectRoot },
      { resolved: { mode: resolved.mode, files: changedFiles }, escalatedRuleIds: escalatedIds },
    );
    reported = [...filtered.includedViolations];
    for (const v of reported) governing.add(v.ruleId);
    reportedStale = staleAll.filter((s) => escalatedIds.has(s.ruleId) || changedSet.has(s.file));
    for (const s of reportedStale) governing.add(s.ruleId);
    selected = rules.filter((r) => governing.has(r.id) || escalatedIds.has(r.id));
    inReportedScope = (file, ruleId) => escalatedIds.has(ruleId) || changedSet.has(file);
    changed = {
      mode: resolved.mode,
      changedFiles,
      governedFiles: [...governedFiles].sort(),
      ignoredLegacyCount: filtered.ignoredLegacyCount,
      ignoredLegacyByRule: filtered.ignoredLegacyByRule,
      escalation: invalidation,
      escalatedRuleIds: [...escalatedIds],
      escalationSuppressed: suppressedEscalation,
    };
  }

  const selectedIds = new Set(selected.map((r) => r.id));
  const changedSet = changed ? new Set(changed.changedFiles) : undefined;
  // The changeset's unread files: each one the scan could not read, and each
  // changed path beneath a directory it could not list — named by file, since
  // the changeset is the scope.
  const changedUnread: readonly IUnreadFile[] = changed
    ? changed.changedFiles.flatMap((f): IUnreadFile[] => {
        const own = unreadAll.find((u) => !isUnreadDirectory(u) && u.path === f);
        if (own) return [own];
        return !scanned.has(f) && beneathUnlisted(f) ? [{ path: f, reason: UnreadFileReason.Unreadable }] : [];
      })
    : [];
  const ruleChecks: IBoundaryRuleCheck[] = selected.map((rule) => {
    const engineDetail = detailById.get(rule.id)!;
    const violations = reported.filter((v) => v.ruleId === rule.id);
    const staleExceptions = reportedStale.filter((s) => s.ruleId === rule.id);
    const scope = boundaryRuleScope(rule);
    // The rule's READ scope over its REPORTED scope: the whole tree, or — for a
    // changed-only run the rule was not escalated in — the changeset (deliberate
    // narrowing: an unread file outside it would not be reported anyway).
    const wholeTree = changedSet === undefined || escalatedIds.has(rule.id);
    const unread = wholeTree
      ? unreadAll.filter((u) => boundaryScopeCoversUnread(scope, u))
      : changedUnread.filter((u) => boundaryScopeDecision(scope, u.path) === 'in');
    const readGap = unread.length > 0;
    const read = wholeTree
      ? engineDetail.filesInScope
      : changed!.changedFiles.filter((f) => scanned.has(f) && boundaryScopeDecision(scope, f) === 'in').length;
    // A dead-unit / does-not-exist claim is a whole-tree claim made from what
    // was READ. THE unread re-settle (round 13) withdraws every claim an unread
    // file could refute and re-settles the rule: such a unit reads Unproven —
    // never a dead line, never an acceptance, never silently dropped.
    const detail = boundaryUnitLiveness(engineDetail, rule, {
      unread: readGap ? [...unreadAll, ...unread] : unreadAll,
      readGap,
      filesScanned: evaluation.filesScanned,
      fileUniverse: evaluation.fileUniverse,
    });
    // The engine skipped the rule because it READ no governed file. When a
    // governed file went unread, that zero is not "matched nothing": the rule
    // is PARTIAL (its coverage says so below), never a failOnEmpty failure.
    const engineSkipped = detail.status === 'skipped' && !readGap;
    // A stale exception fails its rule: the exception list rotted. A rule that
    // checked nothing and fails on empty is `failed` (keeping its skipReason) —
    // the wiring plane's mapping, so `gate.failed` counts the rule that failed
    // the run in every plane. Whether it EXAMINED anything stays the engine's
    // `detail.status`; that, not this, is what "evaluated" counts.
    const status: IBoundaryRuleCheck['status'] = engineSkipped
      ? detail.failedOnEmpty
        ? 'failed'
        : 'skipped'
      : violations.length > 0 || staleExceptions.length > 0
        ? 'failed'
        : 'passed';
    return {
      ruleId: rule.id,
      title: rule.title,
      severity: detail.severity,
      status,
      ...(engineSkipped && detail.skipReason ? { skipReason: detail.skipReason } : {}),
      ...(engineSkipped && detail.failedOnEmpty ? { failedOnEmpty: true } : {}),
      ...(escalatedIds.has(rule.id) ? { escalated: true } : {}),
      // THE unread-file rule (`readScopeCoverage`): examined `read` of the
      // `read + unread` governed files, each unread path named.
      coverage: readScopeCoverage(detail.coverage, readGap ? { read, unread } : undefined),
      ...(readGap ? { unread } : {}),
      detail,
      violations,
      staleExceptions,
    };
  });
  // Each selected rule's settled lists — read, never re-derived.
  const deadUnits = ruleChecks.flatMap((r) => r.detail.deadUnits);
  const unitsIn = (state: UnitLivenessState): IBoundaryUnitFinding[] =>
    ruleChecks.flatMap((r) =>
      (r.detail.unitLiveness ?? []).filter((u) => u.state === state).map((u) => boundaryUnitFinding(r.ruleId, u)),
    );
  const intendedEmpty = unitsIn(UnitLivenessState.IntendedEmpty);
  const wentLive = unitsIn(UnitLivenessState.WentLive);
  // THE `--fail-on-dead-units` / `--strict` predicate (core `selectorUnitFails`):
  // an unmarked dead unit under the flag, a LOCAL went-live marker under the
  // flag or `--strict` (on this verb `--strict` already promotes warnings); a
  // pack marker that went live never — the consumer cannot edit it.
  const unitFlags: ISelectorUnitFailOptions = {
    failOnDeadUnits: options.failOnDeadUnits === true,
    strict: options.strict === true,
    strictPromotesWarnings: true,
  };
  const failingUnits = ruleChecks.flatMap((r) =>
    (r.detail.unitLiveness ?? []).filter((u) => selectorUnitFails(u, unitFlags)).map((u) => boundaryUnitFinding(r.ruleId, u)),
  );
  const suppressed = evaluation.suppressed.filter(
    (s) => selectedIds.has(s.violation.ruleId) && inReportedScope(s.violation.file, s.violation.ruleId),
  );
  const counts = { error: 0, warning: 0, info: 0 };
  for (const v of reported) counts[v.severity] += 1;

  // ── run coverage: rules examined of rules this run is accountable for ──
  // "Checked nothing" is the ENGINE's word — a failOnEmpty rule is `failed`
  // above yet examined nothing, so it is unexamined here all the same. A rule
  // whose only governed files went unread is partial through its own coverage.
  const skippedSel = ruleChecks.filter(boundaryRuleCheckedNothing);
  const unexamined = [...skippedSel.map((r) => r.ruleId), ...suppressedEscalation];
  const expected = selected.length + suppressedEscalation.length;
  const gapReasons: string[] = [];
  if (skippedSel.length > 0) gapReasons.push('checked nothing (their from globs reached no governed file)');
  if (suppressedEscalation.length > 0) {
    gapReasons.push(
      'are defined in a changed rule source, but --no-rule-escalation kept them out — changed-only cannot see a rule edit',
    );
  }
  const emptyReason =
    expected > 0
      ? undefined
      : rules.length === 0
        ? (configuration?.diagnostics[0] ?? 'the rule file defines no rules')
        : changed
          ? `no changed source file is governed by a boundary rule (${changed.changedFiles.length} changed file(s))`
          : 'no rule selected';
  const runCoverage: IVerdictCoverage = {
    unit: 'rules',
    expected,
    examined: expected - unexamined.length,
    ...(unexamined.length > 0
      ? { unexamined: unexamined.slice(0, 20), unexaminedTotal: unexamined.length, reason: gapReasons.join('; ') }
      : {}),
    ...(emptyReason ? { reason: emptyReason } : {}),
    root: projectRoot,
  };

  // ── the proposed exit ──────────────────────────────────────────────────
  //   1  an errored rule (load issue), a stale exception, an error violation
  //      (warnings too under --strict), a failOnEmpty skip, or a selector unit
  //      `selectorUnitFails` fails (a dead unit under --fail-on-dead-units, a
  //      local went-live marker under it or --strict);
  //   2  a selected rule checked nothing;
  //   0  otherwise — including an EMPTY selection, which the run coverage
  //      (expected 0) settles to 2 unless the caller accepts it.
  const failedOnEmpty = skippedSel.filter((r) => r.failedOnEmpty);
  const fails =
    loadIssues.length > 0 ||
    reportedStale.length > 0 ||
    counts.error > 0 ||
    (options.strict === true && counts.warning > 0) ||
    failedOnEmpty.length > 0 ||
    failingUnits.length > 0;
  const proposedExit = fails ? 1 : skippedSel.length > 0 ? 2 : 0;
  // Core's settleVerdict — the SAME fold the CLI's gate envelope runs, so the
  // MCP tools, finish and quality cannot settle this coverage differently.
  const settled = settleVerdict(proposedExit, boundaryCheckCoverage({ runCoverage, rules: ruleChecks, loadIssues }));

  return {
    schema: 'sharkcraft.boundary-check/v1',
    projectRoot,
    ruleSource,
    rulesConfigured: sourceRules.length,
    selectedRuleIds: selected.map((r) => r.id),
    scan,
    evaluation,
    rules: ruleChecks,
    violations: reported,
    counts,
    suppressed,
    staleExceptions: reportedStale,
    deadUnits,
    intendedEmpty,
    wentLive,
    failingUnits,
    loadIssues,
    ...(configuration ? { configuration } : {}),
    ...(changed ? { changed } : {}),
    runCoverage,
    proposedExit,
    exitCode: settled.exit,
    verdict: settled.verdict,
    shortfalls: settled.shortfalls,
    accepted: settled.accepted,
  };
}

/**
 * THE "did this selected rule check nothing?" predicate: the engine read no
 * governed file for it AND no governed file went unread. A rule whose governed
 * files could not be read matched real files it could not examine — PARTIAL
 * through its coverage, never listed as "checked nothing" and never a
 * failOnEmpty failure. Every boundary renderer reads this, not `detail.status`.
 */
export function boundaryRuleCheckedNothing(r: IBoundaryRuleCheck): boolean {
  return r.detail.status === 'skipped' && (r.unread?.length ?? 0) === 0;
}

/**
 * THE coverage records a boundary run settles on: the run coverage, each
 * selected rule's coverage (subject = the rule id) followed by its
 * `expectEmpty` acceptance (round 13 — folded through core's
 * `ruleVerdictRecords`, once when the two are the same record), and one record
 * per errored rule. `runBoundaryCheck` settles with exactly this list, and every
 * surface that folds a boundary run into its own verdict (drift, `architecture
 * violations`, the validation loop) reads it too — never a re-derivation.
 */
export function boundaryCheckCoverage(
  result: Pick<IBoundaryCheckResult, 'runCoverage' | 'rules' | 'loadIssues'>,
): IVerdictCoverage[] {
  return [
    result.runCoverage,
    ...result.rules.flatMap((r) =>
      ruleVerdictRecords(r.coverage, r.detail.unitAcceptance).map((c) => ({ ...c, subject: c.subject ?? r.ruleId })),
    ),
    ...result.loadIssues.map((i) => boundaryLoadIssueCoverage(i)),
  ];
}

/** The selected rules of a run that checked nothing — {@link boundaryRuleCheckedNothing}, over the whole result. */
export function boundaryRulesCheckedNothing(result: Pick<IBoundaryCheckResult, 'rules'>): IBoundaryRuleCheck[] {
  return result.rules.filter(boundaryRuleCheckedNothing);
}

/**
 * THE "accepted as intended-empty" predicate (round 13, K6): the rule settled
 * IntendedEmpty — every `from` inclusion marked `expectEmpty`, no file matched,
 * so it examined 0 files and its coverage IS the acceptance. Read from the
 * engine's settle (`acceptedAsIntendedEmpty`), never re-derived from a coverage
 * shape.
 */
export function boundaryRuleAcceptedEmpty(r: IBoundaryRuleCheck): boolean {
  return r.detail.acceptedAsIntendedEmpty === true;
}

/** The selected rules accepted as intended-empty — {@link boundaryRuleAcceptedEmpty}, over the whole result. */
export function boundaryRulesAcceptedEmpty(result: Pick<IBoundaryCheckResult, 'rules'>): IBoundaryRuleCheck[] {
  return result.rules.filter(boundaryRuleAcceptedEmpty);
}

/**
 * THE "rules evaluated" count every boundary surface reports: the selected
 * rules minus the ones that checked nothing and minus the ones accepted as
 * intended-empty (round 13 — each examined 0 files; a renderer prints them
 * apart: `N evaluated, M accepted as intended-empty`, M from
 * {@link boundaryRulesAcceptedEmpty}). A rule whose governed files went unread
 * is counted (it is PARTIAL through its coverage, not "checked nothing"); a
 * failOnEmpty rule that examined nothing is not. `check boundaries --json`,
 * `diff-check` (CLI + MCP) and MCP `check_boundaries` all read it, so no
 * surface can re-derive it from `detail.status` and disagree.
 */
export function boundaryRulesEvaluated(result: Pick<IBoundaryCheckResult, 'rules'>): number {
  return (
    result.rules.length - boundaryRulesCheckedNothing(result).length - boundaryRulesAcceptedEmpty(result).length
  );
}

/** The `skipped[]` rows of a boundary JSON payload — one shape for the CLI and MCP. */
export function boundarySkippedRuleRows(
  result: Pick<IBoundaryCheckResult, 'rules'>,
): { ruleId: string; reason: string; failed: boolean }[] {
  return boundaryRulesCheckedNothing(result).map((r) => ({
    ruleId: r.ruleId,
    reason: r.skipReason ?? 'checked nothing',
    failed: r.failedOnEmpty === true,
  }));
}

/** A label for a load issue — the rule id when known, else `<file>#<index>` / the file. */
export function boundaryLoadIssueLabel(issue: IBoundaryLoadIssue): string {
  if (issue.ruleId) return issue.ruleId;
  return issue.index !== undefined ? `${issue.file}#${issue.index}` : issue.file;
}

/**
 * The coverage an errored boundary rule carries: one rule asked for, none
 * examined. Shared by the orchestrator's settle and the CLI envelope's rows.
 */
export function boundaryLoadIssueCoverage(issue: IBoundaryLoadIssue): IVerdictCoverage {
  return {
    unit: 'rules',
    expected: 1,
    examined: 0,
    subject: boundaryLoadIssueLabel(issue),
    reason:
      issue.kind === 'missing-file'
        ? 'the listed rule file does not exist'
        : issue.kind === 'load-error'
          ? 'the rule file failed to load'
          : 'failed validation — NOT evaluated',
  };
}

/**
 * Package names the workspace knows: node builtins, the root manifest's
 * dependency sections, and the name + dependencies of every package.json the
 * scan walked. A forbidden pattern naming one is resolvable even when nothing
 * imports it today (a "never adopt X" guard is legitimate).
 */
export function collectKnownPackages(projectRoot: string, scan: IImportScanResult): string[] {
  // THE builtin list (`nodeBuiltinPackageNames`) — the load-time marker refusal
  // reads the same one, so a builtin-named marker is refused exactly when this
  // judge could never call it dead.
  const out = new Set<string>(nodeBuiltinPackageNames());
  for (const rel of new Set(['package.json', ...(scan.manifestFiles ?? [])])) {
    const abs = nodePath.join(projectRoot, rel);
    if (!existsSync(abs)) continue;
    try {
      const json = JSON.parse(readFileSync(abs, 'utf8')) as Record<string, unknown>;
      if (typeof json['name'] === 'string') out.add(json['name']);
      for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        const deps = json[key];
        if (deps && typeof deps === 'object') for (const d of Object.keys(deps)) out.add(d);
      }
    } catch {
      // An unreadable manifest only means its names stay unknown — a pattern
      // naming them may be reported as a dead unit (a warning), never a pass.
    }
  }
  return [...out];
}

function evaluateOptionsFor(projectRoot: string, scan: IImportScanResult): IEvaluateOptions {
  const tsconfigPaths = loadTsconfigPaths(projectRoot);
  return {
    ...(tsconfigPaths.aliases.size > 0 ? { tsconfigPaths } : {}),
    knownPackages: collectKnownPackages(projectRoot, scan),
  };
}

/**
 * `check boundaries --diff-against <file>`: what the candidate rule set would
 * flag, relative to the active one — evaluated by the SAME engine as the gate,
 * against ONE scan.
 *
 * The proposed set is an id overlay: active rules whose id the candidate does
 * not define, plus every candidate rule (a same id REPLACES, a new id ADDS).
 * `onlyRuleId` narrows both sides.
 *
 * Round 13 (P2): each candidate rule's record goes through the SAME unread
 * re-settle as `check boundaries` (`boundaryUnitLiveness`) and the same read
 * scope (`readScopeCoverage`) — an unreadable governed file is never a pass
 * here either, and a dead unit it could refute is Unproven, not reported.
 */
export function diffBoundaryRuleSets(
  inspection: ISharkcraftInspection,
  candidate: { readonly path: string; readonly rules: readonly IBoundaryRule[]; readonly loadIssues?: readonly IBoundaryLoadIssue[] },
  options: {
    readonly onlyRuleId?: string;
    readonly includeComments?: boolean;
    /** `--fail-on-dead-units`: a candidate's dead unit, or local went-live marker, makes the proposal 1. */
    readonly failOnDeadUnits?: boolean;
  } = {},
): IBoundaryRuleSetDiff {
  const projectRoot = inspection.projectRoot;
  const active = inspection.boundaryRegistry.list();
  const activeIds = new Set(active.map((r) => r.id));
  const candidateIds = new Set(candidate.rules.map((r) => r.id));
  const proposed = [...active.filter((r) => !candidateIds.has(r.id)), ...candidate.rules];
  const loadIssues = [...(candidate.loadIssues ?? [])];
  const base = {
    schema: 'sharkcraft.boundary-rule-diff/v1' as const,
    candidateFile: boundaryFileLabel(projectRoot, candidate.path),
    rulesAdded: candidate.rules.filter((r) => !activeIds.has(r.id)).map((r) => r.id),
    rulesReplaced: candidate.rules.filter((r) => activeIds.has(r.id)).map((r) => r.id),
    loadIssues,
  };
  const only = options.onlyRuleId;
  if (only !== undefined && !activeIds.has(only) && !candidateIds.has(only)) {
    const zero = { error: 0, warning: 0, info: 0 };
    return {
      ...base,
      added: [],
      removed: [],
      unchanged: 0,
      perRule: [],
      edgeLevel: { newlyFlagged: [], noLongerFlagged: [] },
      before: { rules: 0, counts: zero },
      after: { rules: 0, counts: zero },
      candidateCoverage: [],
      intendedEmpty: [],
      wentLive: [],
      failingUnits: [],
      proposedExit: 3,
      unknownRuleId: only,
    };
  }
  const narrow = (rs: readonly IBoundaryRule[]): IBoundaryRule[] =>
    only !== undefined ? rs.filter((r) => r.id === only) : [...rs];
  const scan = scanImports({ projectRoot, includeComments: options.includeComments === true });
  const evalOptions = evaluateOptionsFor(projectRoot, scan);
  const before = evaluateBoundaries(scan, narrow(active), evalOptions);
  const after = evaluateBoundaries(scan, narrow(proposed), evalOptions);

  const key = (v: IBoundaryViolation): string => `${v.ruleId}|${v.file}|${v.line}|${v.importSpecifier}`;
  const beforeKeys = new Set(before.violations.map(key));
  const afterKeys = new Set(after.violations.map(key));
  const added = after.violations.filter((v) => !beforeKeys.has(key(v)));
  const removed = before.violations.filter((v) => !afterKeys.has(key(v)));
  const unchanged = after.violations.filter((v) => beforeKeys.has(key(v))).length;
  const ruleIds = [...new Set([...narrow(active), ...narrow(proposed)].map((r) => r.id))];
  const perRule = ruleIds.map((ruleId) => ({
    ruleId,
    added: added.filter((v) => v.ruleId === ruleId).length,
    removed: removed.filter((v) => v.ruleId === ruleId).length,
    unchanged: after.violations.filter((v) => v.ruleId === ruleId && beforeKeys.has(key(v))).length,
  }));
  const edgeKey = (v: IBoundaryViolation): string => `${v.file}|${v.line}|${v.importSpecifier}`;
  const edgesOf = (vs: readonly IBoundaryViolation[]): Map<string, IBoundaryViolation> =>
    new Map(vs.map((v) => [edgeKey(v), v]));
  const beforeEdges = edgesOf(before.violations);
  const afterEdges = edgesOf(after.violations);
  const edge = (v: IBoundaryViolation): { file: string; line: number; importSpecifier: string } => ({
    file: v.file,
    line: v.line,
    importSpecifier: v.importSpecifier,
  });
  const newlyFlagged = [...afterEdges].filter(([k]) => !beforeEdges.has(k)).map(([, v]) => edge(v));
  const noLongerFlagged = [...beforeEdges].filter(([k]) => !afterEdges.has(k)).map(([, v]) => edge(v));

  // The candidate rules' records through THE unread re-settle and read scope
  // `check boundaries` uses — one answer to "is this unit dead?" on both paths.
  const unreadAll: readonly IUnreadFile[] = scan.unread ?? [];
  const proposedById = new Map(narrow(proposed).map((r) => [r.id, r]));
  const candidateCoverage: IBoundaryRuleCoverage[] = after.coverage
    .filter((c) => candidateIds.has(c.ruleId))
    .map((c) => {
      const rule = proposedById.get(c.ruleId);
      if (rule === undefined) return c;
      const unread = unreadAll.filter((u) => boundaryScopeCoversUnread(boundaryRuleScope(rule), u));
      const readGap = unread.length > 0;
      const detail = boundaryUnitLiveness(c, rule, {
        unread: unreadAll,
        readGap,
        filesScanned: after.filesScanned,
        fileUniverse: after.fileUniverse,
      });
      return readGap
        ? { ...detail, coverage: readScopeCoverage(detail.coverage, { read: detail.filesInScope, unread }) }
        : detail;
    });
  const unitsIn = (state: UnitLivenessState): IBoundaryUnitFinding[] =>
    candidateCoverage.flatMap((c) =>
      (c.unitLiveness ?? []).filter((u) => u.state === state).map((u) => boundaryUnitFinding(c.ruleId, u)),
    );
  // THE `--fail-on-dead-units` predicate, as on the gate. `--strict` promotes
  // nothing on this path (the delta counts error violations only), so it
  // fails no went-live marker here.
  const unitFlags: ISelectorUnitFailOptions = {
    failOnDeadUnits: options.failOnDeadUnits === true,
    strict: false,
    strictPromotesWarnings: false,
  };
  const failingUnits = candidateCoverage.flatMap((c) =>
    (c.unitLiveness ?? []).filter((u) => selectorUnitFails(u, unitFlags)).map((u) => boundaryUnitFinding(c.ruleId, u)),
  );
  // A candidate that checked nothing and fails on empty WOULD fail the gate it
  // is headed for — the same `1` the gate itself proposes for it.
  const proposedExit =
    loadIssues.length > 0 ||
    added.some((v) => v.severity === 'error') ||
    candidateCoverage.some((c) => c.failedOnEmpty === true) ||
    failingUnits.length > 0
      ? 1
      : 0;
  return {
    ...base,
    added,
    removed,
    unchanged,
    perRule,
    edgeLevel: { newlyFlagged, noLongerFlagged },
    before: { rules: before.rulesConfigured, counts: before.counts },
    after: { rules: after.rulesConfigured, counts: after.counts },
    candidateCoverage,
    intendedEmpty: unitsIn(UnitLivenessState.IntendedEmpty),
    wentLive: unitsIn(UnitLivenessState.WentLive),
    failingUnits,
    proposedExit,
  };
}
