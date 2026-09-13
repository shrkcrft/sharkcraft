import type {
  IBaselineRule,
  IGeneratedArtifactRule,
  IPolicyRule,
  IRegistrationIdiom,
  IRegistryDeclaration,
  IWiringRule,
  IWiringSource,
  IDocReferenceRule,
  ISelectorUnitFailOptions,
  IUnitLiveness,
  IUnitStateLists,
  IVerdictCoverage,
} from '@shrkcrft/core';
import {
  referencedExtractorIds,
  RuleEmptiness,
  ruleAssertsEmptyOutput,
  selectorUnitFails,
  settleRuleEmptiness,
  settleUnitLiveness,
  unitStateLists,
  UnitLivenessState,
} from '@shrkcrft/core';
import {
  dotDirsNamedBy,
  globListLivenessInput,
  globListSelects,
  inspectSource,
  readGlobListUnits,
  readScopeCoverage,
  readScopeHasUnread,
  runPolicyLint,
  runWiring,
  scanGeneratedFiles,
  sourceLivenessRequest,
  walkMatching,
  withFileReadCache,
  wiringSourceSide,
  type IGlobLivenessList,
  type IGlobLivenessRequest,
  type IReadScope,
  type ISourceInspection,
} from '@shrkcrft/boundaries';
import { gateRuleLabeledSources, gateRuleSources } from './gate-rule-globs.ts';
import type { ICoverageDeadGlob } from './i-coverage-dead-glob.ts';
import type { ICoverageNegation } from './i-coverage-negation.ts';
import { checkDocReferences, type ISharkcraftInspection } from '@shrkcrft/inspector';
import type { IGateRuleView } from './gate-rule-view.ts';
import { buildGateEnvelope, type IGateEnvelope, type IGateRuleResult } from './gate-envelope.ts';
import { evaluateSelfTest } from './self-test.ts';
import { measureRegistrationRoles } from './measure-registration-roles.ts';
import type { ISelfTestCheck } from './self-test-check.ts';
import type { ISelfTestSubject } from './self-test-subject.ts';
import { baselineLivenessRequest } from '../commands/baseline.command.ts';
import { ExitCode } from '../exit-codes.ts';

export const GATE_COVERAGE_SCHEMA = 'sharkcraft.gate-coverage/v1' as const;

/**
 * Why a rule its own negations emptied matched nothing — worded into its
 * coverage reason and its envelope `skipReason`, never the "probably stale" of
 * a selector that matched nothing at all.
 */
const EMPTIED_BY_NEGATIONS = 'its own negations exclude every file its inclusion globs select';

/** Why a rule that matched nothing proves nothing, in the words every coverage row prints. */
const STALE_SELECTOR = 'matched nothing — the selector is probably stale';

/**
 * Whether a rule is connected to anything at all.
 *
 * `empty` is the finding this whole surface exists for: a stale selector that
 * matches nothing passes every gate forever, so the ONLY way to notice is to
 * report the match count itself and flag zero. `failed-expectation` is the
 * stronger form — the author wrote down what the rule should match, and it
 * doesn't. A rule whose empty result is the INTENDED one (round 13: a fence's
 * asserted empty set, or every primary input glob marked `expectEmpty`) is
 * `ok` — its acceptance is printed.
 */
export type GateCoverageStatus = 'ok' | 'empty' | 'error' | 'failed-expectation';

export interface IGateCoverage {
  readonly id: string;
  readonly plane: IGateRuleView['plane'];
  readonly description?: string;
  readonly status: GateCoverageStatus;
  /** Files the rule's primary selector matched. */
  readonly filesMatched: number;
  /** Ids/units the rule extracted (content units scanned, for the policy plane). */
  readonly unitsMatched: number;
  /** What "units" means for this plane, for honest reporting. */
  readonly unitLabel: string;
  /** What one extracted "id" is on this plane — what `expectIds` is checked against. */
  readonly idLabel: string;
  /**
   * The selector coverage (and the selfTest) consulted, e.g.
   * `registry "mcp-tools" — source packages/…/*.tool.ts (regex-capture)`.
   */
  readonly consulted: string;
  /** A few of the extracted ids, so the author can eyeball correctness. */
  readonly sampleIds: readonly string[];
  /**
   * Every extracted id. Populated only when the caller asks (`includeAllIds`),
   * because a full set on every rule would bloat `gates coverage --json` for a
   * fact almost no consumer of it needs — `gates try --full` does.
   */
  readonly allIds?: readonly string[];
  /**
   * The extracted ids a `selfTest` may safely PIN, when that is narrower than
   * the whole set. Present only on the policy plane. It holds the distinct hits
   * an `exemptFiles` / `exemptLines` exemption let through (a fixture proving
   * the forbidden pattern still bites). A live finding is debt the author will
   * pay down, so `gates scaffold-selftest` never pins one: the gate would go
   * red on the day the violation is fixed.
   */
  readonly pinIds?: readonly string[];
  /**
   * `false` when coverage cannot inspect this rule without a side effect: a
   * `command` baseline with no `watchFiles`, or a doc-reference rule whose
   * registries were not loaded. Such a rule's `coverage` records nothing
   * examined. A caller that ran the rule's own check (`shrk quality`) settles
   * it on that check's coverage instead. Absent when the rule was inspected.
   */
  readonly inspectable?: boolean;
  /** True when a zero match is a hard failure for this rule. */
  readonly failOnEmpty: boolean;
  readonly error?: string;
  /**
   * A diagnosis for a zero-match that is correct but probably not intended —
   * e.g. an `import-edges` rule targeting `to.files` against barrel imports.
   * Never set on a rule whose empty result is the intended one (a verified
   * fence, an intended-empty rule): it would invite the author to "fix" it.
   */
  readonly hint?: string;
  /** Unmet `selfTest` expectations, each a sentence naming the selector consulted. */
  readonly expectationFailures: readonly string[];
  /**
   * EVERY declared `selfTest` expectation with its result — held, failed, or
   * not-evaluable — from the one evaluator (`gates/self-test.ts`). Present only
   * when the rule declares a selfTest.
   */
  readonly selfTestChecks?: readonly ISelfTestCheck[];
  /**
   * Globs inside this rule that do nothing — a dead unit a connected rule
   * hides, because its sibling globs keep it matching: an inclusion glob that
   * selects nothing, or a negation that excludes nothing. Prefixed with the
   * side (`declared: src/moved/*.ts`) when the rule reads more than one source.
   * UNMARKED dead units only (round 13): a glob marked `expectEmpty` is
   * intended-empty (accepted) or went-live, never here. Advisory unless
   * `gates coverage --fail-on-dead-units`.
   */
  readonly deadGlobs: readonly string[];
  /**
   * The units behind {@link deadGlobs}, in the same order, each with the
   * reason it is dead (`matched 0 files`, `matches only files the list's
   * negations exclude (N)`, `excludes nothing — …`). Always set by
   * {@link buildGateCoverage}; read it through {@link coverageDeadUnits}.
   */
  readonly deadGlobUnits?: readonly ICoverageDeadGlob[];
  /**
   * The LIVE negations inside this rule (`!` entries that exclude at least one
   * file from their own list), each with what it excludes — the narrowing a
   * `!` performs, made visible. Always set by {@link buildGateCoverage}.
   */
  readonly negations?: readonly ICoverageNegation[];
  /**
   * Present only when the rule's PRIMARY selector list was emptied by its own
   * negations: its inclusion globs matched files and these negations (each
   * with what it excluded) removed every one. A zero match here is the
   * author's `!` at work, not a stale selector — the text line, the `gate`
   * envelope's `skipReason` and `shrk quality` say so. Exits are unchanged.
   */
  readonly excludedByNegations?: readonly ICoverageNegation[];
  /** How many distinct globs the dead-glob check examined (0 = not checked on this plane). */
  readonly globsChecked: number;
  /**
   * Named extractor this rule's primary selector came from. Present only for a
   * `$use` consumer — the answer to "is this rule looking at the shared set, or
   * a copy of it that has since drifted?".
   */
  readonly viaExtractor?: string;
  /**
   * How much of the rule's scope this coverage run could see: every unit it
   * matched; for a subset wiring rule, the registered tokens its declared
   * selector produced (from the engine `check wiring` runs, so the two agree);
   * for a fence, the asserted empty set (accepted by `expectEmpty: true`); for
   * an intended-empty rule, the acceptance of its marked inputs; for a rule
   * that could not be inspected, nothing. The `gate` envelope turns a gap here
   * into a `partial` rule.
   */
  readonly coverage: IVerdictCoverage;
  /**
   * The rule's `expectEmpty` acceptance — settle record B
   * (`settleUnitLiveness(...).acceptance`, `@shrkcrft/core`) over every glob
   * list the rule reads — carried beside the primary {@link coverage} so
   * `settleGateCoverage` hands it to the envelope rule's `unitAcceptance`;
   * without a carrier an acceptance would be dropped silently. Absent when no
   * unit of the rule is intended-empty.
   */
  readonly unitAcceptance?: IVerdictCoverage;
  /** The rule's dead / intended-empty / went-live glob units as printed lines (`unitStateLists`). */
  readonly units?: IUnitStateLists;
  /**
   * The rule's non-live glob units (dead, intended-empty, went-live, unproven),
   * as the settle judged them — what `--fail-on-dead-units` decides through
   * (`selectorUnitFails`) and what the ⚠ `expectEmpty is stale` rows print.
   */
  readonly unitLiveness?: readonly IUnitLiveness[];
  /**
   * Set when the rule matched nothing: THE rule-emptiness settle's state
   * (`settleRuleEmptiness`) — `intended-empty` and `asserted-empty-output`
   * read `ok` (accepted), `stale` / `emptied-by-negations` read `empty`.
   */
  readonly emptiness?: RuleEmptiness;
  /** The skip reason of an `empty` rule, when it is more than "matched 0 units" (a fence over a dead input). */
  readonly emptyReason?: string;
}

/**
 * One named extractor, reported ONCE with the rules that share it.
 *
 * The point of a shared extractor is that its consumers cannot disagree about
 * which set they check. Reporting it once — with its match count and its
 * consumer list — makes that guarantee visible: one line proves N rules are
 * pointed at the same, live, non-empty set.
 */
export interface ISharedExtractorCoverage {
  readonly id: string;
  /** Rule ids (plane-qualified) that resolve their primary selector from it. */
  readonly consumers: readonly string[];
  readonly filesMatched: number;
  readonly idsMatched: number;
  readonly sampleIds: readonly string[];
  readonly error?: string;
}

export interface IGateCoverageReport {
  readonly schema: typeof GATE_COVERAGE_SCHEMA;
  readonly rules: readonly IGateCoverage[];
  readonly total: number;
  readonly empty: number;
  readonly errored: number;
  readonly expectationFailures: number;
  /** Dead globs across every rule (the sum of each rule's `deadGlobs`). */
  readonly deadGlobCount: number;
  /** Named extractors referenced by at least one rule, each reported once. */
  readonly extractors: readonly ISharedExtractorCoverage[];
  /**
   * `pass` — every rule matched something and met its expectations.
   * `stale` — at least one rule matched nothing (or broke an expectation).
   * Dead globs inside connected rules are advisory and do not change it.
   */
  readonly verdict: 'pass' | 'stale';
}

/**
 * What one rule's primary selector resolved to, before expectations are
 * applied — the {@link ISelfTestSubject} the one evaluator reads, plus what
 * the coverage report needs beyond it.
 */
interface IPrimaryMatch extends ISelfTestSubject {
  readonly filesMatched: number;
  readonly error?: string;
  readonly hint?: string;
  /** Named extractor this rule's primary side resolved from, when it used one. */
  readonly viaExtractor?: string;
  /**
   * The rule's coverage, when its plane knows more than "every unit it
   * matched" — the wiring and policy engines and the registration measurement,
   * whose records `check wiring` / `policy-lint` / `gates check` settle on.
   */
  readonly coverage?: IVerdictCoverage;
  /**
   * Set when the primary selector matched a file the reader did NOT read (over
   * the read cap). Such a rule matched something, so it is never `empty` (a
   * failOnEmpty rule settles PARTIAL, not FAILED); a plane with no engine
   * `coverage` folds it through `readScopeCoverage`, the one rule.
   */
  readonly readScope?: IReadScope;
  /**
   * EVERY glob list the rule reads, with its markers — the request the one
   * gate-plane settle runs on (round 13). Built per plane from the same
   * helpers the plane engines use, so `gates coverage` and the plane verb read
   * one rule's units alike.
   */
  readonly liveness: IGlobLivenessRequest;
  /** The `list` values of the rule's PRIMARY selector — what its emptiness is decided from. */
  readonly primaryLists: readonly string[];
  /** See {@link IGateCoverage.pinIds}. */
  readonly pinIds?: readonly string[];
  /** `false` when the rule cannot be inspected without a side effect (see {@link IGateCoverage.inspectable}). */
  readonly inspectable?: false;
}

/** A source inspection's read scope, when it left a matched file unread. */
function inspectionReadScope(insp: ISourceInspection): { readonly readScope?: IReadScope } {
  return insp.unread.length > 0 ? { readScope: { read: insp.filesScanned, unread: insp.unread } } : {};
}

/** How a report names one extraction source: `a/*.ts, b/*.ts (regex-capture)`. */
function describeSource(src: IWiringSource): string {
  const kind =
    src.extract ??
    (src.pattern !== undefined ? 'regex-capture' : src.arrayProperty !== undefined ? 'array-members' : 'extractor');
  const files = (src.files ?? []).join(', ') || '(no files)';
  return `${files} (${kind}${src.$use ? `, via $use:${src.$use}` : ''})`;
}

/** ONE rule-level glob list as the settle reads it, judged off the one reader's walk (memoised under the coverage window). */
function ruleList(
  cwd: string,
  list: string,
  globs: readonly string[],
  excludeDirs: readonly string[],
  allowDotDirs?: ReadonlySet<string>,
): IGlobLivenessList {
  return { list, globs, units: readGlobListUnits(cwd, globs, new Set(excludeDirs), allowDotDirs) };
}

/** The labelled-sources request of a source-reading rule (wiring, registry, registration). */
function sourcesRequest(cwd: string, view: IGateRuleView, excludeDirs: readonly string[]): IGlobLivenessRequest {
  return sourceLivenessRequest(cwd, gateRuleLabeledSources(view), excludeDirs, view.id);
}

function matchWiring(
  cwd: string,
  view: IGateRuleView,
  rule: IWiringRule,
  excludeDirs: readonly string[],
): IPrimaryMatch {
  const side = wiringSourceSide(rule);
  const sideLabel = rule.chain && rule.chain.length > 0 ? 'chain[0]' : 'declared';
  const base = {
    unitLabel: 'ids',
    idLabel: 'declared tokens',
    consulted: side
      ? `wiring rule "${rule.id}" — ${sideLabel} ${describeSource(side)}`
      : `wiring rule "${rule.id}"`,
    liveness: sourcesRequest(cwd, view, excludeDirs),
    primaryLists: [`${sideLabel}.files`],
  };
  if (!side) return { ...base, filesMatched: 0, unitsMatched: 0, ids: [], error: 'rule sets no source side' };
  const insp = inspectSource(cwd, side, excludeDirs);
  // The REGISTERED side too, through the same evaluator `check wiring` and
  // `gates check` run. A subset rule whose declared selector never produced a
  // registered member is connected — but only partially — and coverage must
  // agree with the check about that, so it asks the check instead of
  // re-deriving the set difference here. (An intended-empty rule's engine
  // record IS its acceptance.)
  const evaluated =
    insp.error === undefined ? runWiring(cwd, [rule], { excludeDirs }).rules[0] : undefined;
  return {
    ...base,
    filesMatched: insp.filesScanned,
    unitsMatched: insp.ids.length,
    ids: insp.ids,
    ...(side.$use ? { viaExtractor: side.$use } : {}),
    ...(insp.error ? { error: insp.error } : {}),
    ...(insp.hint ? { hint: insp.hint } : {}),
    ...(evaluated ? { coverage: evaluated.coverage } : {}),
    ...inspectionReadScope(insp),
  };
}

/**
 * A policy rule's "ids" are its PATTERN MATCHES, exactly as the engine reports
 * each hit: capture group 1 when the pattern has one, else the whole match
 * (whitespace-collapsed, at most 120 chars).
 *
 * Findings AND hits an exemption (`exemptFiles` / `exemptLines`) let through
 * both count — an exempted fixture file is real code the author deliberately
 * allowed, and it is the only liveness pin a policy rule can have ("the
 * forbidden pattern still bites"). A hit the rule's OWN `scan` zone dropped
 * does not count: the zone says that text is prose or a string, and letting it
 * satisfy `expectIds` would be the false signal zones exist to remove.
 *
 * `unitsMatched` stays the content units scanned, so a clean rule with zero
 * hits is still connected (`ok`), not `empty`.
 */
function matchPolicy(cwd: string, rule: IPolicyRule, excludeDirs: readonly string[]): IPrimaryMatch {
  const report = runPolicyLint(cwd, [rule], { excludeDirs });
  const result = report.rules[0];
  // Hits an exemption let through: the fixtures the author deliberately kept.
  // These are the only ids a scaffolded selfTest may pin (see IGateCoverage.pinIds).
  const exempted = report.suppressed
    .filter((s) => s.ruleId === rule.id && (s.via === 'exemptFiles' || s.via === 'exemptLines'))
    .map((s) => s.match);
  const ids = [
    ...new Set([
      ...report.findings.filter((f) => f.ruleId === rule.id).map((f) => f.match),
      ...report.suppressed
        .filter((s) => s.ruleId === rule.id && s.via !== 'scanZone')
        .map((s) => s.match),
    ]),
  ].sort();
  const own = rule.files ?? [];
  return {
    // A policy rule's "files" and "units" differ only for inline templates.
    filesMatched: result?.unitsScanned ?? 0,
    unitsMatched: result?.unitsScanned ?? 0,
    unitLabel: 'content units',
    idLabel: 'pattern matches (capture group 1, else the whole match — findings plus exempted hits)',
    consulted:
      `policy rule "${rule.id}" — /${rule.pattern}/${rule.flags ?? ''} over ` +
      (own.length > 0 ? own.join(', ') : `the ${rule.surface} surface's default globs`),
    ids,
    pinIds: [...new Set(exempted)].sort(),
    // Only the author's own `files[]` is a selector anyone wrote (a surface's
    // default globs are not judged) — the list `runPolicyLint` settles too.
    liveness: {
      subject: rule.id,
      lists: own.length > 0 ? [ruleList(cwd, 'files', own, excludeDirs)] : [],
      marks: rule.expectEmptyUnits ?? [],
    },
    primaryLists: own.length > 0 ? ['files'] : [],
    ...(result?.error ? { error: result.error } : {}),
    // The ENGINE's own record, the one `policy-lint` / `gates check` settle on
    // (it names any matched file the reader left unread), never re-derived.
    ...(result ? { coverage: result.coverage } : {}),
    // A rule with an unread file carries the file record, whose `examined` is
    // the read count.
    ...(result?.unread ? { readScope: { read: result.coverage.examined, unread: result.unread } } : {}),
  };
}

function matchRegistry(
  cwd: string,
  view: IGateRuleView,
  decl: IRegistryDeclaration,
  excludeDirs: readonly string[],
): IPrimaryMatch {
  const insp = inspectSource(cwd, decl.source, excludeDirs);
  return {
    filesMatched: insp.filesScanned,
    unitsMatched: insp.ids.length,
    unitLabel: 'ids',
    idLabel: 'registry ids',
    consulted: `registry "${decl.name}" — source ${describeSource(decl.source)}`,
    ids: insp.ids,
    liveness: sourcesRequest(cwd, view, excludeDirs),
    primaryLists: ['source.files'],
    ...(decl.source.$use ? { viaExtractor: decl.source.$use } : {}),
    ...(insp.error ? { error: insp.error } : {}),
    ...(insp.hint ? { hint: insp.hint } : {}),
    ...inspectionReadScope(insp),
  };
}

function matchRegistration(
  cwd: string,
  view: IGateRuleView,
  idiom: IRegistrationIdiom,
  excludeDirs: readonly string[],
): IPrimaryMatch {
  // The ONE per-role measurement `gates check` reads too. Its empty is the
  // declared role's (the idiom's primary selector), and its coverage names
  // every role that examined nothing — an intended-empty role rides on the
  // acceptance instead. So the two verbs agree on "empty", on "partial" and on
  // "accepted" by construction, not by coincidence.
  const roles = measureRegistrationRoles(cwd, idiom, excludeDirs);
  const insp = roles.declared;
  return {
    filesMatched: insp.filesScanned,
    unitsMatched: insp.ids.length,
    unitLabel: 'declared tokens',
    idLabel: 'declared tokens',
    consulted: `registration idiom "${idiom.name}" — declared ${describeSource(idiom.declared)}`,
    ids: insp.ids,
    liveness: sourcesRequest(cwd, view, excludeDirs),
    primaryLists: ['declared.files'],
    coverage: roles.coverage,
    ...(idiom.declared.$use ? { viaExtractor: idiom.declared.$use } : {}),
    // Only the PRIMARY side's error makes the rule misconfigured here, as on
    // the wiring plane. A provided/consumed error is an unexamined role in
    // `roles.coverage`.
    ...(roles.roleErrors.declared !== undefined ? { error: roles.roleErrors.declared } : {}),
    ...(insp.hint ? { hint: insp.hint } : {}),
    ...inspectionReadScope(insp),
  };
}

function matchBaseline(cwd: string, rule: IBaselineRule, excludeDirs: readonly string[]): IPrimaryMatch {
  // THE input request `baseline check` settles too (compute.source + watchFiles).
  const built = baselineLivenessRequest(cwd, rule, excludeDirs);
  // Only the EXTRACTOR half can be inspected without spawning. A command
  // compute is reported honestly as un-inspectable rather than guessed at —
  // `shrk baseline explain --id X` runs it on purpose.
  if (rule.compute.kind !== 'extractor' || !rule.compute.source) {
    // ...but its INPUTS can still be probed. `watchFiles` names the files that
    // feed the command, so globbing them (never spawning) answers the one
    // question the trust layer otherwise cannot: is this rule still connected
    // to the repo at all? A command baseline whose watchFiles point at a moved
    // directory is indistinguishable from a healthy one without this.
    const watch = rule.watchFiles ?? [];
    if (watch.length === 0) {
      return {
        filesMatched: 0,
        unitsMatched: 0,
        unitLabel: 'entries (command compute — not inspected; add `watchFiles` to enable the probe)',
        idLabel: 'entries',
        consulted: `baseline "${rule.id}" — a \`command\` compute (never run by coverage)`,
        ids: [],
        // A selfTest here asserts on a set nothing can produce without
        // spawning the command. Report that instead of a fake "got 0" that
        // would keep the rule red forever.
        notEvaluable:
          'a `command` baseline is never run by coverage, and this one declares no `watchFiles` to probe — add `watchFiles` (then the selfTest counts watchFiles paths)',
        liveness: built.request,
        primaryLists: [],
        inspectable: false,
      };
    }
    // The probe walks the POSITIVE set (inclusion globs), then selects through
    // the list — a `!` in watchFiles excludes. EVERY probed path, sorted:
    // `expectIds` may name any watched file, not just whichever five the walk
    // happened to visit first. The one dead-unit decision judges the globs (in
    // the request above), and a directory the walk could not list is an unread
    // entry for it (a glob that may match beneath one is not dead).
    const walked = walkMatching(cwd, watch, new Set(excludeDirs), new Set());
    const probed = walked.filter((p) => globListSelects(p, watch)).sort();
    return {
      filesMatched: probed.length,
      unitsMatched: probed.length,
      // A zero here is a REAL empty (stale watchFiles), so the label must not
      // carry the "not inspected" marker that suppresses the empty verdict.
      unitLabel: 'watchFiles input(s) (compute unverified — command never run)',
      idLabel: 'watchFiles paths',
      consulted: `baseline "${rule.id}" — watchFiles ${watch.join(', ')} (probed; the command is never run)`,
      ids: probed,
      liveness: built.request,
      // The probe IS this rule's match in coverage: its watchFiles is primary.
      primaryLists: ['watchFiles'],
    };
  }
  const insp = inspectSource(cwd, rule.compute.source, excludeDirs);
  return {
    filesMatched: insp.filesScanned,
    unitsMatched: insp.ids.length,
    unitLabel: 'entries',
    idLabel: 'entries',
    consulted: `baseline "${rule.id}" — compute.source ${describeSource(rule.compute.source)}`,
    ids: insp.ids,
    liveness: built.request,
    primaryLists: built.primaryLists,
    ...(rule.compute.source.$use ? { viaExtractor: rule.compute.source.$use } : {}),
    ...(insp.error ? { error: insp.error } : {}),
    ...(insp.hint ? { hint: insp.hint } : {}),
    ...inspectionReadScope(insp),
  };
}

/**
 * A doc-reference rule's "match" is how many id-shaped TOKENS it validated.
 *
 * Files alone would lie: a rule whose globs match 40 docs but whose
 * `requireContext` gate rejects every token is enforcing nothing, and coverage
 * exists precisely to make that visible.
 */
function matchDocReference(
  cwd: string,
  rule: IDocReferenceRule,
  inspection: ISharkcraftInspection,
  excludeDirs: readonly string[],
): IPrimaryMatch {
  const res = checkDocReferences(cwd, rule, inspection, excludeDirs);
  return {
    filesMatched: res.filesScanned,
    unitsMatched: res.tokensChecked,
    unitLabel: 'doc reference(s)',
    idLabel: 'validated doc-reference tokens',
    consulted: docReferenceConsulted(rule),
    ids: [...new Set(res.tokens.filter((t) => t.skipped === undefined).map((t) => t.token))].sort(),
    // The rule's `files` judged per unit off the SAME walk the check reads (its
    // dot-dirs included; a memo hit under `withFileReadCache`): a live negation
    // is printed with what it excludes, a dead glob or a `!` excluding nothing
    // is a dead unit — as on every other plane.
    liveness: {
      subject: rule.id,
      lists: [ruleList(cwd, 'files', rule.files, excludeDirs, dotDirsNamedBy(rule.files))],
      marks: rule.expectEmptyUnits ?? [],
    },
    primaryLists: ['files'],
    ...(res.error ? { error: res.error } : {}),
    ...(res.readScope ? { readScope: res.readScope } : {}),
  };
}

function docReferenceConsulted(rule: IDocReferenceRule): string {
  return (
    `doc-reference rule "${rule.id}" — /${rule.tokenPattern}/${rule.tokenPatternFlags ?? ''} over ${rule.files.join(', ')}, ` +
    `resolved as ${rule.resolvesAs.join(' | ')}`
  );
}

function matchGenerated(cwd: string, rule: IGeneratedArtifactRule, excludeDirs: readonly string[]): IPrimaryMatch {
  const scan = scanGeneratedFiles(cwd, rule, excludeDirs);
  const files = [...scan.generated.keys()];
  // `generatedGlob` judged per unit off the walk `scanGeneratedFiles` just
  // read (a memo hit). `sources[].glob`, `outsideGlob` and `handMaintained`
  // are not judged here: the writers partition the generated set (`unclassified`
  // reports a gap), and a stale bless has its own finding.
  return {
    filesMatched: files.length,
    unitsMatched: files.length,
    unitLabel: 'generated files',
    idLabel: 'generated file paths',
    consulted: `generated artifact "${rule.id}" — ${rule.generatedGlob.join(', ')}`,
    ids: files,
    liveness: {
      subject: rule.id,
      lists: [ruleList(cwd, 'generatedGlob', rule.generatedGlob, excludeDirs)],
      marks: rule.expectEmptyUnits ?? [],
    },
    primaryLists: ['generatedGlob'],
    ...(readScopeHasUnread(scan.readScope) ? { readScope: scan.readScope } : {}),
  };
}

/**
 * Resolve every declared rule against the live tree and report what it matched.
 *
 * The `command`-compute baseline is the one rule kind that cannot be inspected
 * without side effects; it is reported as un-inspected (never as `empty`), so
 * the report never claims a fact it did not check.
 */
export function buildGateCoverage(
  cwd: string,
  rules: readonly IGateRuleView[],
  excludeDirs: readonly string[] = [],
  extractors: Readonly<Record<string, IWiringSource>> = {},
  includeAllIds = false,
  inspection?: ISharkcraftInspection,
): IGateCoverageReport {
  // Safe to memo the tree reads for exactly this call: coverage NEVER spawns
  // (the `command` baseline is probed, not run) and never writes, so nothing
  // can change the tree between the first rule's scan and the last one's.
  return withFileReadCache(() =>
    buildGateCoverageUncached(cwd, rules, excludeDirs, extractors, includeAllIds, inspection),
  );
}

function buildGateCoverageUncached(
  cwd: string,
  rules: readonly IGateRuleView[],
  excludeDirs: readonly string[],
  extractors: Readonly<Record<string, IWiringSource>>,
  includeAllIds: boolean,
  inspection: ISharkcraftInspection | undefined,
): IGateCoverageReport {
  const out: IGateCoverage[] = [];
  for (const view of rules) {
    let match: IPrimaryMatch;
    switch (view.plane) {
      case 'wiring':
        match = matchWiring(cwd, view, view.raw as IWiringRule, excludeDirs);
        break;
      case 'policy':
        match = matchPolicy(cwd, view.raw as IPolicyRule, excludeDirs);
        break;
      case 'registry':
        match = matchRegistry(cwd, view, view.raw as IRegistryDeclaration, excludeDirs);
        break;
      case 'registration':
        match = matchRegistration(cwd, view, view.raw as IRegistrationIdiom, excludeDirs);
        break;
      case 'baseline':
        match = matchBaseline(cwd, view.raw as IBaselineRule, excludeDirs);
        break;
      case 'doc-reference': {
        // The inspection is only built when this plane is actually present, so
        // a repo without it never pays for the registries.
        const rule = view.raw as IDocReferenceRule;
        match = inspection
          ? matchDocReference(cwd, rule, inspection, excludeDirs)
          : {
              filesMatched: 0,
              unitsMatched: 0,
              unitLabel: 'doc reference(s) (registries not loaded — not inspected)',
              idLabel: 'validated doc-reference tokens',
              consulted: docReferenceConsulted(rule),
              ids: [],
              notEvaluable: 'the registries a doc reference resolves against were not loaded',
              liveness: { subject: rule.id, lists: [], marks: [] },
              primaryLists: [],
              inspectable: false,
            };
        break;
      }
      default:
        match = matchGenerated(cwd, view.raw as IGeneratedArtifactRule, excludeDirs);
        break;
    }
    // ONE evaluator for every plane (and for `gates try`). A selector that
    // could not run has no extracted set, so its expectations are unmeasured —
    // reported as such, never as a fabricated "got 0".
    const checks = evaluateSelfTest(
      view.selfTest,
      match.error !== undefined && match.notEvaluable === undefined
        ? { ...match, notEvaluable: `the selector could not run (${match.error})` }
        : match,
    );
    const failedChecks = checks.filter((c) => c.status === 'failed');
    const unevaluable = checks.filter((c) => c.status === 'not-evaluable');
    const expectationFailures = failedChecks.map((c) => c.message);
    // A selfTest field this plane shape can never evaluate is a misconfigured
    // rule (it can never pass), so it surfaces as the rule's error.
    const error =
      match.error ?? (unevaluable.length > 0 ? unevaluable.map((c) => c.message).join('; ') : undefined);
    // A structured flag, never a substring of the human label: the quality
    // bundle reads the same fact to settle such a rule on its check's coverage.
    const uninspected = match.inspectable === false;

    // THE gate-plane glob settle (round 13): core's `settleUnitLiveness` over
    // THE observation predicate (`globListLivenessInput`) and every list the
    // rule reads, with its `expectEmpty` markers — the input each plane engine
    // builds too, so `gates coverage`, `gates try`, `quality` and every plane
    // verb judge one glob alike. `settled.dead` is the UNMARKED dead units
    // only; a marked glob is intended-empty (record B) or went-live.
    const settled = settleUnitLiveness(globListLivenessInput(match.liveness));
    const lists = match.liveness.lists;
    const primaryList = lists.find((l) => match.primaryLists.includes(l.list));
    const labelOf = (l: IGlobLivenessList, glob: string): string => (l.label !== undefined ? `${l.label}: ${glob}` : glob);
    const negations: ICoverageNegation[] = lists.flatMap((l) =>
      l.units.negations.map((n) => ({ selector: labelOf(l, n.glob), excludes: n.excludes })),
    );
    const excludedByNegations =
      primaryList !== undefined && primaryList.units.allExcluded
        ? primaryList.units.negations.map((n) => ({ selector: labelOf(primaryList, n.glob), excludes: n.excludes }))
        : undefined;
    const deadGlobUnits: ICoverageDeadGlob[] = settled.dead.map((u) => ({
      selector: u.label,
      glob: u.unit,
      negation: u.unit.startsWith('!'),
      reason: u.deadReason ?? 'matched 0 files',
    }));

    // A selector that matched a file the reader could not read matched
    // something: it is not stale, so it is never `empty` (and a failOnEmpty
    // rule never FAILS on it). Its coverage names the unread file instead.
    const matchedUnread = readScopeHasUnread(match.readScope);
    // THE rule-emptiness settle (round 13) — the one call that replaces the
    // three `expectEmpty` consults: a FENCE's asserted empty set over live
    // inputs (`ruleAssertsEmptyOutput`), a rule whose every primary inclusion
    // glob is intended-empty and matched no file, or the loud skip. A fence
    // over a DEAD input is stale, never accepted; 0 units out of live files is
    // never assertable.
    const emptiness = settleRuleEmptiness({
      subject: view.id,
      unitLabel: match.unitLabel,
      filesMatched: match.filesMatched,
      unitsMatched: match.unitsMatched,
      unread: matchedUnread,
      emptiedByNegations: excludedByNegations !== undefined,
      emptiedReason: `matched nothing — ${EMPTIED_BY_NEGATIONS}`,
      liveness: settled,
      primaryLists: match.primaryLists,
      assertsEmptyOutput: ruleAssertsEmptyOutput(view),
      failOnEmpty: view.failOnEmpty,
      noFilesReason: STALE_SELECTOR,
      noUnitsReason: STALE_SELECTOR,
    });
    const accepted =
      emptiness.state === RuleEmptiness.AssertedEmptyOutput || emptiness.state === RuleEmptiness.IntendedEmpty;
    const status: GateCoverageStatus =
      error !== undefined
        ? 'error'
        : failedChecks.length > 0
          ? 'failed-expectation'
          : !uninspected && emptiness.skipped
            ? 'empty'
            : 'ok';
    // The scope this coverage run could actually see. A plane whose engine
    // knows more supplies its own record (wiring, policy, registration — an
    // intended-empty rule's record IS its acceptance); an accepted empty is the
    // settle's own record; a rule coverage could not inspect examined nothing
    // — it is never reported "connected" on faith. Every other plane's record
    // folds the reader's unread files through the one rule, `readScopeCoverage`.
    const coverage: IVerdictCoverage =
      match.coverage ??
      readScopeCoverage(
        uninspected
          ? {
              unit: 'inspectable inputs',
              expected: 1,
              examined: 0,
              reason: `not inspected — ${match.unitLabel}`,
            }
          : (emptiness.coverage ?? {
              unit: match.unitLabel,
              expected: match.unitsMatched,
              examined: match.unitsMatched,
              ...(match.unitsMatched === 0
                ? {
                    // A rule that could not RUN is misconfigured, not stale:
                    // its zero is no evidence about the selector at all
                    // (round 12 review, R12-X3).
                    reason:
                      error !== undefined
                        ? 'NOT evaluated — the rule is misconfigured (see its error)'
                        : (emptiness.skipReason ?? STALE_SELECTOR),
                  }
                : {}),
            }),
        match.readScope,
      );
    const nonLive = settled.units.filter((u) => u.state !== UnitLivenessState.Live);
    out.push({
      id: view.id,
      plane: view.plane,
      ...(view.description ? { description: view.description } : {}),
      status,
      coverage,
      ...(settled.acceptance !== undefined ? { unitAcceptance: settled.acceptance } : {}),
      ...(settled.dead.length + settled.intendedEmpty.length + settled.wentLive.length > 0
        ? { units: unitStateLists(settled) }
        : {}),
      ...(nonLive.length > 0 ? { unitLiveness: nonLive } : {}),
      ...(emptiness.state !== RuleEmptiness.Matched ? { emptiness: emptiness.state } : {}),
      ...(emptiness.cause === 'dead-input' && emptiness.skipReason !== undefined
        ? { emptyReason: emptiness.skipReason }
        : {}),
      filesMatched: match.filesMatched,
      unitsMatched: match.unitsMatched,
      unitLabel:
        emptiness.state === RuleEmptiness.AssertedEmptyOutput
          ? `${match.unitLabel} (empty — the asserted state)`
          : emptiness.state === RuleEmptiness.IntendedEmpty
            ? `${match.unitLabel} (empty — asserted by expectEmpty)`
            : match.unitLabel,
      idLabel: match.idLabel,
      consulted: match.consulted,
      sampleIds: match.ids.slice(0, 5),
      ...(includeAllIds ? { allIds: match.ids } : {}),
      ...(match.pinIds !== undefined ? { pinIds: match.pinIds } : {}),
      ...(uninspected ? { inspectable: false } : {}),
      failOnEmpty: view.failOnEmpty,
      ...(error !== undefined ? { error } : {}),
      // A diagnosis of a probably-unintended zero (the import-edges barrel
      // hint) is never printed over an ACCEPTED empty: it would invite the
      // author to "fix" a correct fence.
      ...(match.hint && !accepted ? { hint: match.hint } : {}),
      ...(match.viaExtractor ? { viaExtractor: match.viaExtractor } : {}),
      expectationFailures,
      ...(checks.length > 0 ? { selfTestChecks: checks } : {}),
      deadGlobs: deadGlobUnits.map((u) => u.selector),
      deadGlobUnits,
      negations,
      ...(excludedByNegations !== undefined ? { excludedByNegations } : {}),
      globsChecked: lists.reduce((n, l) => n + l.units.checked, 0),
    });
  }

  // Report each SHARED extractor once, with the rules that consume it. One
  // resolve per extractor, not per consumer — the shared definition is a single
  // fact about the tree, and stating it N times would invite the reader to
  // treat N agreeing consumers as N independent confirmations.
  //
  // Consumers are collected from EVERY side of every rule, not just the side
  // coverage happens to inspect: a rule bound to the extractor through its
  // `registered` sink is every bit as bound as one using it for `declared`, and
  // listing half of them would understate the guarantee.
  const consumersByExtractor = new Map<string, string[]>();
  for (const view of rules) {
    const label = `${view.plane}:${view.id}`;
    for (const id of referencedExtractorIds(gateRuleSources(view))) {
      const list = consumersByExtractor.get(id) ?? [];
      if (!list.includes(label)) list.push(label);
      consumersByExtractor.set(id, list);
    }
  }
  const extractorCoverage: ISharedExtractorCoverage[] = [...consumersByExtractor.keys()]
    .sort()
    .map((id) => {
      const definition = extractors[id];
      if (!definition) {
        return {
          id,
          consumers: consumersByExtractor.get(id)!,
          filesMatched: 0,
          idsMatched: 0,
          sampleIds: [],
          error: 'referenced but not declared in `extractors`',
        };
      }
      const insp = inspectSource(cwd, definition, excludeDirs);
      return {
        id,
        consumers: consumersByExtractor.get(id)!,
        filesMatched: insp.filesScanned,
        idsMatched: insp.ids.length,
        sampleIds: insp.ids.slice(0, 5),
        ...(insp.error ? { error: insp.error } : {}),
        ...(insp.hint ? { hint: insp.hint } : {}),
      };
    });
  const empty = out.filter((r) => r.status === 'empty').length;
  const errored = out.filter((r) => r.status === 'error').length;
  const expectationFailures = out.filter((r) => r.status === 'failed-expectation').length;
  return {
    schema: GATE_COVERAGE_SCHEMA,
    rules: out,
    total: out.length,
    empty,
    errored,
    expectationFailures,
    deadGlobCount: out.filter(reportsDeadGlobs).reduce((n, r) => n + r.deadGlobs.length, 0),
    extractors: extractorCoverage,
    verdict: empty + errored + expectationFailures > 0 ? 'stale' : 'pass',
  };
}

/**
 * The coverage report with every pack rule the merge seam REJECTED folded in as
 * a misconfigured (`error`) row (round 12 review, R12-X1) — from THE rows
 * `seamRejectedRules` builds for `gates check`, so the coverage verb and the
 * check cannot disagree about a rule that never ran. It counts in `total` and
 * `errored`, so `settleGateCoverage` fails it (exit 1) and names it unexamined.
 */
export function withRejectedRules(
  report: IGateCoverageReport,
  rejected: readonly (IGateRuleResult & { readonly type: IGateRuleView['plane'] })[],
): IGateCoverageReport {
  if (rejected.length === 0) return report;
  const rows: IGateCoverage[] = rejected.map((r) => ({
    id: r.id,
    plane: r.type,
    status: 'error',
    coverage: r.coverage,
    filesMatched: 0,
    unitsMatched: 0,
    unitLabel: 'units (rejected at the pack-plane merge seam — not evaluated)',
    idLabel: 'extracted ids',
    consulted: 'nothing — the pack element failed validation before any selector ran',
    sampleIds: [],
    failOnEmpty: true,
    ...(r.error !== undefined ? { error: r.error } : {}),
    expectationFailures: [],
    deadGlobs: [],
    deadGlobUnits: [],
    negations: [],
    globsChecked: 0,
  }));
  const all = [...report.rules, ...rows];
  const errored = all.filter((r) => r.status === 'error').length;
  return {
    ...report,
    rules: all,
    total: all.length,
    errored,
    verdict: report.empty + errored + report.expectationFailures > 0 ? 'stale' : 'pass',
  };
}

/**
 * Whether a rule's dead globs are a finding of their OWN: the rule is connected
 * (it matched something, or it is an inspected fence / clean rule reported
 * `ok`), so sibling globs can hide the dead ones.
 *
 * A rule already reported as matching nothing has no live sibling to hide
 * behind. Its "matched nothing" verdict (skip, or failOnEmpty failure) already
 * says it, so its dead globs are not counted, drawn or failed a second time.
 * `--fail-on-dead-units` must never turn a soft-empty rule's `2` into a `1`.
 * The report count, the ⚠ lines, the settle and the quality notes all read
 * this one predicate.
 */
export function reportsDeadGlobs(r: IGateCoverage): boolean {
  if (r.deadGlobs.length === 0 || r.status === 'empty') return false;
  return r.status === 'ok' || r.unitsMatched > 0;
}

/**
 * THE dead units of a coverage row, each with its reason — what the ⚠ line,
 * the `--fail-on-dead-units` violation and the `shrk quality` note all print,
 * so the three cannot word one unit differently. A row built without
 * `deadGlobUnits` (a hand-built report) falls back to its `deadGlobs` labels,
 * read as inclusion globs that matched nothing.
 */
export function coverageDeadUnits(r: IGateCoverage): readonly ICoverageDeadGlob[] {
  if (r.deadGlobUnits !== undefined && r.deadGlobUnits.length === r.deadGlobs.length) return r.deadGlobUnits;
  return r.deadGlobs.map((g) => ({ selector: g, glob: g, negation: false, reason: 'matched 0 files' }));
}

/**
 * THE went-live units of a coverage row (round 13): each glob marked
 * `expectEmpty` whose target now exists — the fence went live. What the ⚠
 * `expectEmpty is stale` rows, the `--fail-on-dead-units` violation and the
 * `shrk quality` note print.
 */
export function coverageWentLiveUnits(r: IGateCoverage): readonly IUnitLiveness[] {
  return (r.unitLiveness ?? []).filter((u) => u.state === UnitLivenessState.WentLive);
}

/**
 * The selector units that FAIL a coverage row under the given flags — decided
 * by THE predicate every `--fail-on-dead-units` consumer calls
 * (`selectorUnitFails`, core): an unmarked dead glob of a connected rule
 * ({@link reportsDeadGlobs}), and a LOCAL went-live marker. A pack marker that
 * went live is INFO, never a failure; an intended-empty unit never fails.
 */
export function coverageUnitFailures(
  r: IGateCoverage,
  flags: ISelectorUnitFailOptions,
): readonly { readonly selector: string; readonly message: string }[] {
  const dead = reportsDeadGlobs(r)
    ? coverageDeadUnits(r)
        .filter(() => selectorUnitFails({ state: UnitLivenessState.Dead }, flags))
        .map((u) => ({ selector: u.selector, message: `${u.reason} (--fail-on-dead-units)` }))
    : [];
  const wentLive = coverageWentLiveUnits(r)
    .filter((u) => selectorUnitFails(u, flags))
    .map((u) => ({ selector: u.label, message: `${u.message} (--fail-on-dead-units)` }));
  return [...dead, ...wentLive];
}

/** `declared: src/moved/*.ts (matched 0 files), !src/nowhere/** (excludes nothing — …)`. */
export function formatDeadUnits(units: readonly ICoverageDeadGlob[]): string {
  return units.map((u) => `${u.selector} (${u.reason})`).join(', ');
}

/** `declared: !src/**\/*.spec.ts (1 file), !docs/drafts/** (3 files)`. */
export function formatNegations(negations: readonly ICoverageNegation[]): string {
  return negations.map((n) => `${n.selector} (${n.excludes} file${n.excludes === 1 ? '' : 's'})`).join(', ');
}

/** Options for {@link settleGateCoverage}. */
interface ISettleGateCoverageOptions {
  /** `--fail-on-dead-units`: a dead glob inside a connected rule, or a local went-live marker, fails the run. */
  readonly failOnDeadUnits?: boolean;
}

/**
 * Settle a coverage report into the shared `gate` envelope — THE derivation of
 * what `gates coverage` concludes.
 *
 * `gates coverage` and `shrk quality`'s coverage item both call this, so the
 * pre-push bundle cannot pass a rule set the verb itself reports broken (a
 * failed selfTest, a stale failOnEmpty selector, a partial rule). A rule that
 * matched nothing is not-verified (2) by default; `failOnEmpty` on the rule
 * makes it a failure (1); `failOnDeadUnits` makes a dead glob inside a
 * connected rule — or a local marker whose target went live — a failure too
 * (`selectorUnitFails`). Each rule's `expectEmpty` acceptance rides on its
 * envelope rule (`unitAcceptance`) into the one settle.
 */
export function settleGateCoverage(
  report: IGateCoverageReport,
  options: ISettleGateCoverageOptions = {},
): IGateEnvelope {
  const flags: ISelectorUnitFailOptions = {
    failOnDeadUnits: options.failOnDeadUnits === true,
    // `gates coverage` is not where --strict promotes warnings (check boundaries is).
    strict: false,
    strictPromotesWarnings: false,
  };
  const unitFailures = (r: IGateCoverage): readonly { readonly selector: string; readonly message: string }[] =>
    coverageUnitFailures(r, flags);
  const deadFails = (r: IGateCoverage): boolean => unitFailures(r).length > 0;
  const hard = report.rules.filter(
    (r) =>
      r.status === 'error' ||
      r.status === 'failed-expectation' ||
      (r.status === 'empty' && r.failOnEmpty) ||
      deadFails(r),
  );
  const softEmpty = report.rules.filter((r) => r.status === 'empty' && !r.failOnEmpty);
  const proposed =
    hard.length > 0 ? ExitCode.Failure : softEmpty.length > 0 ? ExitCode.NotVerified : ExitCode.VerifiedPass;
  const unconnected = report.rules
    .filter((r) => r.status === 'empty' || r.status === 'error')
    .map((r) => r.id);
  return buildGateEnvelope(
    'gates coverage',
    proposed,
    report.rules.map(
      (r): IGateRuleResult => ({
        id: r.id,
        type: r.plane,
        status:
          r.status === 'ok'
            ? deadFails(r)
              ? 'failed'
              : 'passed'
            : r.status === 'empty'
              ? r.failOnEmpty || deadFails(r)
                ? 'failed'
                : 'skipped'
              : r.status === 'error'
                ? 'error'
                : 'failed',
        severity: r.failOnEmpty || deadFails(r) ? 'error' : 'warning',
        counts: { files: r.filesMatched, units: r.unitsMatched },
        violations: [
          ...r.expectationFailures.map((f) => ({ id: r.id, message: f })),
          ...unitFailures(r).map((f) => ({ id: f.selector, message: f.message })),
        ],
        ...(r.status === 'empty'
          ? {
              skipReason:
                r.emptyReason ??
                (r.excludedByNegations !== undefined
                  ? `matched 0 ${r.unitLabel} — ${EMPTIED_BY_NEGATIONS}`
                  : `matched 0 ${r.unitLabel}`),
            }
          : {}),
        ...(r.error ? { error: r.error } : {}),
        coverage: r.coverage,
        ...(r.unitAcceptance !== undefined ? { unitAcceptance: r.unitAcceptance } : {}),
        ...(r.units !== undefined ? { units: r.units } : {}),
      }),
    ),
    {
      unit: 'rules',
      expected: report.total,
      examined: report.total - unconnected.length,
      ...(unconnected.length > 0
        ? { unexamined: unconnected, reason: 'matched nothing or could not run' }
        : {}),
    },
  );
}
