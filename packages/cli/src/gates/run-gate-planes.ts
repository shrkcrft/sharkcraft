import {
  failsWhenEmpty,
  resolveSourceGlobs,
  RuleEmptiness,
  settleRuleEmptiness,
  unitStateLists,
  UnitLivenessState,
  type ISettledUnitLiveness,
  type IUnitLiveness,
  type IUnitStateLists,
  type IVerdictCoverage,
} from '@shrkcrft/core';
import { checkDocReferences, type ISharkcraftInspection } from '@shrkcrft/inspector';
import type {
  IBaselineRule,
  IDocReferenceRule,
  IGeneratedArtifactRule,
  IPolicyRule,
  IRegistrationIdiom,
  IRegistryDeclaration,
  IWiringRule,
} from '@shrkcrft/core';
import {
  buildRegistrationGraph,
  globListSelects,
  readScopeCoverage,
  readScopeHasUnread,
  registrationOrphans,
  registrationUnprovided,
  registryDuplicates,
  runPolicyLint,
  runWiring,
  scanRegistry,
  settleGlobLists,
} from '@shrkcrft/boundaries';
import { baselineCoverage, evaluateBaselineRule } from '../commands/baseline.command.ts';
import {
  evaluateGeneratedRule,
  generatedCoverage,
  generatedHintFor,
} from '../commands/generated.command.ts';
import { docReferenceCoverage } from '../commands/docs-references.command.ts';
import { policyRuleCoverage } from '../commands/policy-lint.command.ts';
import type { IGateRuleResult } from './gate-envelope.ts';
import type { IUnitStateNoteRow } from './i-unit-state-note-row.ts';
import type { GatePlane, IGateRuleView } from './gate-rule-view.ts';
import { measureRegistrationRoles } from './measure-registration-roles.ts';
import { registryLiveness } from './registry-liveness.ts';

/**
 * Run every data-defined plane's VIOLATION check and normalize the results.
 *
 * Each plane already has a verb, but gating a change meant running five of them
 * and `&&`-chaining five exit codes — so in practice people ran one or two. The
 * value here is that one call answers "does this change violate any declared
 * rule?" with one exit code, and it does so by calling the SAME evaluators the
 * per-plane verbs call. A second implementation of any plane's check would
 * eventually disagree with the verb, and the aggregate — the one wired into CI
 * — would be the copy nobody notices is wrong.
 *
 * The same holds for COVERAGE: each rule's `coverage` comes from the plane's
 * own coverage function (the one its verb uses), so `gates check` and the
 * per-plane verb can never disagree about how much of a rule's scope was
 * examined. Round 13: so does each rule's `expectEmpty` acceptance
 * (`unitAcceptance`, folded into the envelope's one settle) and its unit lines.
 */

export interface IRunGatePlanesOptions {
  readonly cwd: string;
  readonly excludeDirs: readonly string[];
  /**
   * Restrict to rules whose footprint intersects these changed files. Scoping
   * is applied by the CALLER (it owns the git diff); this is passed through to
   * the plane engines that scope internally.
   */
  readonly changedFiles?: readonly string[];
  /**
   * Skip every check that would SPAWN a shell (a `command` baseline compute, a
   * generated `regen`). The header/classification halves still run, so the
   * result stays honest — a skipped drift check is reported as skipped, never
   * folded into a pass.
   */
  readonly noSpawn?: boolean;
  /**
   * Registries for the doc-reference plane. Built lazily by the caller — a
   * repo without that plane never loads them.
   */
  readonly inspection?: ISharkcraftInspection;
}

/** One plane's contribution, plus any engine diagnostics it produced. */
export interface IGatePlaneRun {
  readonly results: readonly IGateRuleResult[];
  readonly diagnostics: readonly string[];
  /**
   * Each rule's settled non-live selector units (round 13, K2) — what THE
   * shared unit-state renderer (`unitStateNotes`) reads, so `gates check` lists
   * a dead unit or a went-live marker exactly as the plane verb does. Kept off
   * the envelope rows, which carry the `units` lines only.
   */
  readonly noteRows?: readonly IUnitStateNoteRow[];
}

/**
 * A plane's rule result as the plane functions below build it: the envelope
 * row plus the rule's settled non-live units. `runGatePlanes` strips
 * `unitLiveness` off the row (the envelope carries the `units` lines only) into
 * `IGatePlaneRun.noteRows` — what THE shared unit-state renderer reads, so
 * `gates check` lists a went-live marker exactly as the plane verbs do (K2).
 */
type PlaneRuleResult = IGateRuleResult & { readonly unitLiveness?: readonly IUnitLiveness[] };

/** The unit fields a plane engine put on its result, passed through to the envelope rule (round 13). */
function unitFields(r: {
  readonly unitAcceptance?: IVerdictCoverage;
  readonly units?: IUnitStateLists;
  readonly unitLiveness?: readonly IUnitLiveness[];
}): Pick<PlaneRuleResult, 'unitAcceptance' | 'units' | 'unitLiveness'> {
  return {
    ...(r.unitAcceptance !== undefined ? { unitAcceptance: r.unitAcceptance } : {}),
    ...(r.units !== undefined ? { units: r.units } : {}),
    ...(r.unitLiveness !== undefined && r.unitLiveness.length > 0 ? { unitLiveness: r.unitLiveness } : {}),
  };
}

/** The same, from a settle this module ran itself. */
function livenessFields(
  l: ISettledUnitLiveness | undefined,
): Pick<PlaneRuleResult, 'unitAcceptance' | 'units' | 'unitLiveness'> {
  if (l === undefined) return {};
  const nonLive = l.units.filter((u) => u.state !== UnitLivenessState.Live);
  return {
    ...(l.acceptance !== undefined ? { unitAcceptance: l.acceptance } : {}),
    ...(l.dead.length + l.intendedEmpty.length + l.wentLive.length > 0 ? { units: unitStateLists(l) } : {}),
    ...(nonLive.length > 0 ? { unitLiveness: nonLive } : {}),
  };
}

/** Evaluate the given rules, dispatching each to its plane's real engine. */
export function runGatePlanes(
  rules: readonly IGateRuleView[],
  options: IRunGatePlanesOptions,
): IGatePlaneRun {
  const results: IGateRuleResult[] = [];
  const diagnostics: string[] = [];
  const byPlane = <T>(plane: GatePlane): T[] =>
    rules.filter((r) => r.plane === plane).map((r) => r.raw as T);

  const planeResults: PlaneRuleResult[] = [
    ...runWiringPlane(byPlane<IWiringRule>('wiring'), options, diagnostics),
    ...runPolicyPlane(byPlane<IPolicyRule>('policy'), options),
    ...runRegistryPlane(byPlane<IRegistryDeclaration>('registry'), options),
    ...runRegistrationPlane(byPlane<IRegistrationIdiom>('registration'), options),
    ...runBaselinePlane(byPlane<IBaselineRule>('baseline'), options),
    ...runGeneratedPlane(byPlane<IGeneratedArtifactRule>('generated'), options),
    ...runDocReferencePlane(byPlane<IDocReferenceRule>('doc-reference'), options),
  ];
  // Each rule's settled units leave its envelope row (the envelope carries the
  // `units` lines) for the note rows THE shared unit-state renderer reads (K2).
  const noteRows: IUnitStateNoteRow[] = [];
  for (const r of planeResults) {
    const { unitLiveness, ...row } = r;
    results.push(row);
    if (unitLiveness !== undefined) {
      noteRows.push({ id: r.id, unitLiveness, reportedEmpty: r.status === 'skipped' || r.skipReason !== undefined });
    }
  }

  return { results, diagnostics, noteRows };
}

function runWiringPlane(
  rules: readonly IWiringRule[],
  options: IRunGatePlanesOptions,
  diagnostics: string[],
): PlaneRuleResult[] {
  if (rules.length === 0) return [];
  const report = runWiring(options.cwd, rules, { excludeDirs: options.excludeDirs });
  diagnostics.push(...report.diagnostics);
  return report.rules.map((r) => {
    const skip = report.skipped.find((s) => s.ruleId === r.ruleId);
    return {
      id: r.ruleId,
      type: 'wiring' as const,
      status: r.status,
      severity: r.severity,
      counts: { declared: r.declaredCount, registered: r.registeredCount },
      violations: r.violations.map((v) => ({
        id: v.token,
        ...(v.file ? { file: v.file } : {}),
        ...(v.line !== undefined ? { line: v.line } : {}),
        ...(v.message ? { message: v.message } : {}),
        ...(v.hint ? { hint: v.hint } : {}),
      })),
      ...(skip ? { skipReason: skip.reason } : {}),
      ...(r.error ? { error: r.error } : {}),
      // The engine's own coverage — a subset rule's registered-only tokens
      // arrive here as unexamined, which is what makes it `partial`.
      coverage: r.coverage,
      ...unitFields(r),
    };
  });
}

function runPolicyPlane(
  rules: readonly IPolicyRule[],
  options: IRunGatePlanesOptions,
): PlaneRuleResult[] {
  if (rules.length === 0) return [];
  const report = runPolicyLint(options.cwd, rules, { excludeDirs: options.excludeDirs });
  return report.rules.map((r) => {
    const rule = rules.find((x) => x.id === r.ruleId);
    const findings = report.findings.filter((f) => f.ruleId === r.ruleId);
    const skip = report.skipped.find((s) => s.ruleId === r.ruleId);
    return {
      id: r.ruleId,
      type: 'policy' as const,
      status: r.status,
      severity: r.severity,
      counts: { units: r.unitsScanned, findings: r.findingCount, suppressed: r.suppressedCount },
      violations: findings.map((f) => ({
        id: f.file,
        file: f.file,
        line: f.line,
        message: f.message,
        ...(f.suggest ?? rule?.suggest ? { hint: f.suggest ?? rule!.suggest! } : {}),
      })),
      ...(skip ? { skipReason: skip.reason } : {}),
      ...(r.error ? { error: r.error } : {}),
      coverage: policyRuleCoverage(r),
      ...unitFields(r),
    };
  });
}

/**
 * The registry plane's violation check is DUPLICATES: two roots claiming one id
 * compile fine, and whichever registration wins at runtime is an accident of
 * load order. (Presence queries are lookups, not gates, so they are not run.)
 */
function runRegistryPlane(
  decls: readonly IRegistryDeclaration[],
  options: IRunGatePlanesOptions,
): PlaneRuleResult[] {
  return decls.map((decl) => {
    const inventory = scanRegistry(options.cwd, decl, { excludeDirs: options.excludeDirs });
    const dupes = registryDuplicates(inventory);
    // A source file the reader could not read (over the read cap) makes the
    // inventory incomplete. Zero ids over it is not "matched nothing" (never a
    // failOnEmpty failure), and "no duplicates" over it is not a pass: its
    // coverage is the file record, so the rule settles PARTIAL.
    const empty = inventory.entries.length === 0 && !readScopeHasUnread(inventory.readScope);
    // The registry's globs settled with their `expectEmpty` markers (round 13)
    // — only when a unit is marked, or the inventory is empty (what it is
    // decided from). The registry verbs read the same `registryLiveness`.
    const marked = [decl.source, decl.consumer].some((s) => (s?.expectEmptyUnits?.length ?? 0) > 0);
    const liveness = marked || empty ? registryLiveness(options.cwd, decl, options.excludeDirs) : undefined;
    // `failOnEmpty` makes a dead inventory BLOCK, exactly as a failOnEmpty
    // wiring rule does; without it an empty registry stays a loud skip. A
    // registry has no severity of its own, so THE failOnEmpty authority answers
    // for a warning-severity rule (default off; an explicit `true` promotes it).
    const failOnEmpty = failsWhenEmpty({
      ...(decl.failOnEmpty !== undefined ? { failOnEmpty: decl.failOnEmpty } : {}),
      severity: 'warning',
    });
    const staleReason = failOnEmpty
      ? 'matched 0 ids — failOnEmpty: the source selector is probably stale'
      : 'matched 0 ids — the source selector is probably stale';
    // THE rule-emptiness settle: every source inclusion glob marked
    // `expectEmpty` and no source file matched → an inventory over a planned
    // directory, accepted and printed; anything else is the loud skip.
    const emptiness =
      empty && liveness !== undefined
        ? settleRuleEmptiness({
            subject: decl.name,
            unitLabel: 'ids',
            filesMatched: inventory.readScope.read,
            unitsMatched: 0,
            unread: false,
            liveness,
            primaryLists: ['source.files'],
            failOnEmpty,
            noFilesReason: staleReason,
            noUnitsReason: staleReason,
          })
        : undefined;
    const intended = emptiness?.state === RuleEmptiness.IntendedEmpty && emptiness.coverage !== undefined;
    const skipped = emptiness?.skipped === true;
    const skipReason = emptiness?.skipReason ?? staleReason;
    return {
      id: decl.name,
      type: 'registry' as const,
      status: skipped
        ? emptiness?.fails
          ? ('failed' as const)
          : ('skipped' as const)
        : dupes.length > 0
          ? ('failed' as const)
          : ('passed' as const),
      severity: emptiness?.fails ? ('error' as const) : ('warning' as const),
      counts: { ids: inventory.entries.length, duplicates: dupes.length },
      violations: dupes.map((d) => ({
        id: d.id,
        ...(d.sites[0] ? { file: d.sites[0].file, line: d.sites[0].line } : {}),
        message: `declared in ${d.sites.length} places: ${d.sites.map((s) => `${s.file}:${s.line}`).join(', ')}`,
        hint: 'remove the duplicate declaration — which one wins is load-order roulette',
      })),
      ...(skipped ? { skipReason } : {}),
      coverage:
        intended && emptiness?.coverage !== undefined
          ? emptiness.coverage
          : readScopeCoverage(
              {
                unit: 'ids',
                expected: inventory.entries.length,
                examined: inventory.entries.length,
                ...(skipped ? { reason: skipReason } : {}),
              },
              inventory.readScope,
            ),
      ...livenessFields(liveness),
    };
  });
}

/**
 * The registration plane's violation check is UNPROVIDED: a token declared or
 * consumed but provided by nothing resolves to nothing at runtime — invisible
 * to the compiler, which is the entire reason this plane exists. Orphans (a
 * provider nothing consumes) are COUNTED but do not fail: a registration ahead
 * of its consumer is a normal intermediate state, not a defect.
 */
function runRegistrationPlane(
  idioms: readonly IRegistrationIdiom[],
  options: IRunGatePlanesOptions,
): PlaneRuleResult[] {
  if (idioms.length === 0) return [];
  // The graph is built from EVERY idiom at once (that is what makes a
  // declared→provided→consumed chain traceable across them), so a finding has
  // to be attributed back by matching its sites against each idiom's own globs.
  // Dumping every finding on the first idiom would leave the others reading
  // `passed` while their tokens resolve to nothing — a green that means nothing.
  const graph = buildRegistrationGraph(options.cwd, idioms, { excludeDirs: options.excludeDirs });
  const unprovided = registrationUnprovided(graph, options.changedFiles);
  const orphans = registrationOrphans(graph, options.changedFiles);

  // Per ROLE list: a role's `!x` subtracts from that role only, so it never
  // disowns a file another role of the idiom reads.
  const ownsFile = (idiom: IRegistrationIdiom, file: string): boolean =>
    [idiom.declared, idiom.consumed, idiom.provided].some((role) =>
      globListSelects(file, resolveSourceGlobs(role)),
    );

  return idioms.map((idiom) => {
    const mine = unprovided.filter((t) =>
      [...t.declared, ...t.consumed].some((site) => ownsFile(idiom, site.file)),
    );
    const myOrphans = orphans.filter((t) => t.provided.some((site) => ownsFile(idiom, site.file)));
    // "Is this idiom empty?" and "which role examined nothing?" come from the
    // ONE measurement `gates coverage` reads too. Keying emptiness on the
    // graph's token union used to print a ✓ over an idiom whose declared glob
    // had moved (its provided/consumed roles kept the union non-empty), while
    // coverage FAILED the same idiom.
    const roles = measureRegistrationRoles(options.cwd, idiom, options.excludeDirs);
    const failOnEmpty = failsWhenEmpty({
      ...(idiom.failOnEmpty !== undefined ? { failOnEmpty: idiom.failOnEmpty } : {}),
      severity: 'warning',
    });
    const staleReason =
      `the declared role extracted 0 tokens${failOnEmpty ? ' (failOnEmpty)' : ''}, ` +
      'so the declared selector is probably stale';
    // THE rule-emptiness settle (round 13) on the declared role — the idiom's
    // primary selector: every declared inclusion glob marked `expectEmpty` and
    // no declared file matched → a planned token space, accepted; 0 tokens out
    // of live declared files is the loud skip it always was.
    const emptiness =
      roles.error === undefined && roles.empty
        ? settleRuleEmptiness({
            subject: idiom.name,
            unitLabel: 'declared tokens',
            filesMatched: roles.declared.filesScanned,
            unitsMatched: 0,
            unread: false,
            liveness: roles.liveness ?? settleGlobLists({ subject: idiom.name, lists: [], marks: [] }),
            primaryLists: ['declared.files'],
            failOnEmpty,
            noFilesReason: staleReason,
            noUnitsReason: staleReason,
          })
        : undefined;
    const skipped = emptiness?.skipped === true;
    return {
      id: idiom.name,
      type: 'registration' as const,
      status:
        roles.error !== undefined
          ? ('error' as const)
          : skipped
            ? emptiness?.fails
              ? ('failed' as const)
              : ('skipped' as const)
            : mine.length > 0
              ? ('failed' as const)
              : ('passed' as const),
      severity: emptiness?.fails ? ('error' as const) : ('warning' as const),
      counts: { tokens: graph.tokens.length, unprovided: mine.length, orphans: myOrphans.length },
      violations: mine.map((t) => ({
        id: t.token,
        ...(t.declared[0] ? { file: t.declared[0].file, line: t.declared[0].line } : {}),
        message: 'declared/consumed but provided by nothing — resolves to nothing at runtime',
        hint: `trace it with \`shrk wiring chain ${t.token}\``,
      })),
      ...(skipped ? { skipReason: emptiness?.skipReason ?? staleReason } : {}),
      ...(roles.error !== undefined ? { error: roles.error } : {}),
      // A dead role is an unexamined unit: the rule settles to `partial`, never
      // ✓. An intended-empty role rides on the acceptance instead.
      coverage: roles.coverage,
      ...livenessFields(roles.liveness),
    };
  });
}

function runBaselinePlane(
  rules: readonly IBaselineRule[],
  options: IRunGatePlanesOptions,
): PlaneRuleResult[] {
  return rules.map((rule) => {
    // A `command` compute spawns a shell. Under --no-spawn it is reported as
    // skipped WITH the reason, never silently treated as clean.
    if (options.noSpawn && rule.compute.kind === 'command') {
      return {
        id: rule.id,
        type: 'baseline' as const,
        status: 'skipped' as const,
        severity: rule.severity ?? 'error',
        counts: { committed: 0, current: 0 },
        violations: [],
        skipReason: '`command` compute skipped by --no-spawn',
        coverage: { unit: 'baseline computes', expected: 1, examined: 0, reason: 'skipped by --no-spawn' },
      };
    }
    const o = evaluateBaselineRule(options.cwd, rule, options.excludeDirs, options.changedFiles);
    return {
      id: o.rule.id,
      type: 'baseline' as const,
      status: o.status,
      severity: o.rule.severity ?? 'error',
      counts: { committed: o.committedCount, current: o.currentCount },
      violations: [
        ...(o.diff?.added ?? []).map((e) => ({ id: e, message: 'gained since the baseline was blessed' })),
        ...(o.diff?.removed ?? []).map((e) => ({ id: e, message: 'LOST since the baseline was blessed' })),
      ].map((v) => ({ ...v, hint: rule.hint ?? `bless with \`shrk baseline update --id ${rule.id}\`` })),
      ...(o.skipReason ? { skipReason: o.skipReason } : {}),
      ...(o.error ? { error: o.error } : {}),
      coverage: baselineCoverage(o),
      ...unitFields(o),
    };
  });
}

/**
 * The doc-reference plane's violation check: an id cited in prose that resolves
 * to nothing. Skipped honestly when the registries were not loaded — claiming a
 * pass without having checked is the failure mode this whole surface exists to
 * prevent.
 */
function runDocReferencePlane(
  rules: readonly IDocReferenceRule[],
  options: IRunGatePlanesOptions,
): PlaneRuleResult[] {
  if (rules.length === 0) return [];
  const inspection = options.inspection;
  if (!inspection) {
    const skipReason = 'registries not loaded — doc references were not resolved';
    return rules.map((rule) => ({
      id: rule.id,
      type: 'doc-reference' as const,
      status: 'skipped' as const,
      severity: rule.severity ?? 'error',
      counts: { files: 0, tokens: 0 },
      violations: [],
      skipReason,
      coverage: { unit: 'references', expected: 0, examined: 0, reason: skipReason },
    }));
  }
  return rules.map((rule) => {
    const res = checkDocReferences(options.cwd, rule, inspection, options.excludeDirs);
    return {
      id: res.ruleId,
      type: 'doc-reference' as const,
      status: res.status,
      severity: res.severity,
      counts: { files: res.filesScanned, tokens: res.tokensChecked, skipped: res.tokensSkipped },
      violations: res.findings.map((f) => ({
        id: f.token,
        file: f.file,
        line: f.line,
        message: f.message,
        ...(f.didYouMean.length > 0 ? { hint: `did you mean: ${f.didYouMean.join(', ')}` } : {}),
      })),
      ...(res.skipReason ? { skipReason: res.skipReason } : {}),
      ...(res.error ? { error: res.error } : {}),
      coverage: docReferenceCoverage(res),
      ...unitFields(res),
    };
  });
}

function runGeneratedPlane(
  rules: readonly IGeneratedArtifactRule[],
  options: IRunGatePlanesOptions,
): PlaneRuleResult[] {
  return rules.map((rule) => {
    // --no-spawn keeps the header + classification halves (pure reads) and
    // drops only the regen diff, which is reported as a partial run.
    const headersOnly = options.noSpawn === true;
    const o = evaluateGeneratedRule(options.cwd, rule, options.excludeDirs, headersOnly);
    const spawnSkipped = headersOnly && (rule.regen !== undefined || (rule.sources?.length ?? 0) > 0);
    // A rule whose DRIFT half was skipped has not passed — it partially ran. A
    // header contract holding proves nothing about whether the file was
    // hand-edited, so reporting `passed` here would be the exact false green
    // this plane exists to prevent. Findings still fail; the clean case
    // downgrades to `skipped` so the aggregate exit is 2, not 0.
    const status: IGateRuleResult['status'] =
      spawnSkipped && o.status === 'passed' ? 'skipped' : o.status;
    return {
      id: o.rule.id,
      type: 'generated' as const,
      status,
      severity: o.rule.severity ?? 'error',
      counts: {
        files: o.committedCount,
        differences: o.treeDiff?.differences.length ?? 0,
        provenance: o.provenance.length,
      },
      violations: [
        ...(o.treeDiff?.differences ?? []).map((d) => ({
          id: d.file,
          file: d.file,
          message: d.kind,
          hint: generatedHintFor(o.rule),
        })),
        ...o.provenance.map((f) => ({
          id: f.file,
          file: f.file,
          message: f.message,
          hint: generatedHintFor(o.rule),
        })),
      ],
      ...(o.skipReason
        ? { skipReason: o.skipReason }
        : spawnSkipped
          ? { skipReason: 'regen drift check skipped by --no-spawn (headers + classification still ran)' }
          : {}),
      ...(o.error ? { error: o.error } : {}),
      coverage: generatedCoverage(o, spawnSkipped),
      ...unitFields(o),
    };
  });
}
