/**
 * `shrk baseline` — the committed-baseline drift engine.
 *
 *   shrk baseline list                      # every declared baseline
 *   shrk baseline check [--id X]            # recompute + diff vs committed
 *   shrk baseline diff  [--id X]            # human-readable +added/−removed (never fails)
 *   shrk baseline update [--id X]           # the explicit, reviewable bless step
 *   shrk baseline explain --id X            # what it will run/extract, without judging
 *
 * Rules come from `sharkcraft.config.ts baselines[]`. A `compute.kind:
 * "command"` baseline SPAWNS a shell command — which is why the pack-plane
 * merge seam (`resolveProjectConfig`) drops any pack-contributed baseline that
 * declares one. Everything reaching this command with a `run` therefore came
 * from the repo's OWN config, the same trust boundary `verificationCommands`
 * uses.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import type {
  IBaselineRule,
  ISettledRuleEmptiness,
  ISettledUnitLiveness,
  IUnitLiveness,
  IUnitStateLists,
} from '@shrkcrft/core';
import type { IGlobLivenessRequest } from '@shrkcrft/boundaries';
import {
  coverageShortfall,
  failsWhenEmpty,
  formatEmptyRuleAdvice,
  normalizeRuleList,
  normalizeWiringSource,
  resolveSourceGlobs,
  RuleEmptiness,
  ruleAssertsEmptyOutput,
  settleRuleEmptiness,
  unitStateLists,
  UnitLivenessState,
} from '@shrkcrft/core';
import { settleVerdict } from '../gates/settle-verdict.ts';
import {
  baselineCount,
  baselineFails,
  ceilingValue,
  clearFileReadCache,
  computeBaselineFromExtractor,
  diffBaseline,
  evaluateCeiling,
  globListSelects,
  planeScanExcludeDirs,
  readGlobListUnits,
  readScopeCoverage,
  readScopeHasUnread,
  settleGlobLists,
  sourceLivenessRequest,
  type IBaselineDiff,
  type ICeilingVerdict,
  type IReadScope,
} from '@shrkcrft/boundaries';
import { resolveChangedFiles, resolveProjectConfig } from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { PositionalMode } from '../dispatch/positional-mode.ts';
import { ExitCode } from '../exit-codes.ts';
import { asJson, header, kv } from '../output/format-output.ts';
import { buildGateEnvelope, type IGateRuleResult } from '../gates/gate-envelope.ts';
import { verdictLine } from '../gates/verdict-line.ts';
import { acceptedEmptyNote } from '../gates/accepted-empty-note.ts';
import { emptyRuleAdviceLines } from '../gates/empty-rule-advice-lines.ts';
import { qualifyCleanForUnits } from '../gates/qualify-clean-for-units.ts';
import { unitStateNotes } from '../gates/unit-state-notes.ts';
import { planeVerdictForExit } from '../gates/plane-verdict.ts';
import { seamRejectedRules } from '../gates/seam-rejected-rules.ts';
import type { IVerdictCoverage } from '@shrkcrft/core';

const SCHEMA = 'sharkcraft.baseline/v1';
const DEFAULT_TIMEOUT_MS = 60_000;

/** Loaded rules + the merge notes, or a config-load failure. */
interface ILoadedBaselines {
  readonly rules: readonly IBaselineRule[];
  readonly planeDiagnostics: readonly string[];
  readonly sharkcraftDirRel: string;
  /** Pack baselines the merge seam rejected — declared, never computed (round 12 review, R12-X1). */
  readonly rejected: readonly IGateRuleResult[];
}

async function loadBaselines(
  cwd: string,
): Promise<{ ok: true; value: ILoadedBaselines } | { ok: false; message: string }> {
  const loaded = await resolveProjectConfig(cwd);
  if (!loaded.ok) return { ok: false, message: loaded.error.message };
  return {
    ok: true,
    value: {
      rules: loaded.value.config.baselines ?? [],
      planeDiagnostics: loaded.value.planeDiagnostics,
      rejected: seamRejectedRules(loaded.value, ['baseline']),
      // THE plane scan scope (one entry, or none).
      sharkcraftDirRel: planeScanExcludeDirs(cwd, loaded.value.sharkcraftDir)[0] ?? '',
    },
  };
}

/** Narrow to `--id`, refusing an unknown id rather than silently selecting nothing. */
function selectRules(
  rules: readonly IBaselineRule[],
  id: string | undefined,
  /** Ids that are declared but did not load (merge-seam rejections) — selectable by a verdict verb. */
  extraKnown: readonly string[] = [],
): { ok: true; rules: readonly IBaselineRule[] } | { ok: false; message: string } {
  if (!id) return { ok: true, rules };
  const wanted = id.split(',').map((s) => s.trim()).filter(Boolean);
  const known = new Set([...rules.map((r) => r.id), ...extraKnown]);
  const unknown = wanted.filter((w) => !known.has(w));
  if (unknown.length > 0) {
    return {
      ok: false,
      message: `Unknown baseline id(s): ${unknown.join(', ')}. Declared: ${[...known].join(', ') || '(none)'}`,
    };
  }
  return { ok: true, rules: rules.filter((r) => wanted.includes(r.id)) };
}

/** The current value of a baseline, recomputed from scratch. */
interface IComputed {
  readonly text: string;
  readonly error?: string;
  readonly filesScanned?: number;
  /** Set when the extractor matched a file the reader did not read: the value is incomplete. */
  readonly readScope?: IReadScope;
  /**
   * How many UNITS the compute measured: an extractor's distinct ids (its
   * serialised text is `[]` when it found none, so text can never answer
   * "empty?" for it — round 13, P1), or for a command 1 when it printed
   * anything and 0 when it printed nothing.
   */
  readonly unitCount: number;
}

function computeCurrent(cwd: string, rule: IBaselineRule, excludeDirs: readonly string[]): IComputed {
  if (rule.compute.kind === 'extractor') {
    const source = rule.compute.source;
    if (!source) return { text: '', error: 'compute.kind "extractor" but no `source` declared', unitCount: 0 };
    const res = computeBaselineFromExtractor(cwd, source, excludeDirs);
    const readScope = res.unread.length > 0 ? { readScope: { read: res.filesScanned, unread: res.unread } } : {};
    return res.error
      ? { text: '', error: res.error, filesScanned: res.filesScanned, unitCount: 0 }
      : { text: res.text, filesScanned: res.filesScanned, unitCount: res.ids.length, ...readScope };
  }
  const run = rule.compute.run;
  if (!run || run.trim() === '') {
    return { text: '', error: 'compute.kind "command" but no `run` declared', unitCount: 0 };
  }
  const child = spawnSync(run, {
    cwd,
    shell: true,
    encoding: 'utf8',
    timeout: rule.compute.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  // The command may rewrite files anywhere: drop every memoised tree read, so
  // a read-cache window (`withFileReadCache`, e.g. `shrk quality`'s plane
  // section) never serves a pre-spawn snapshot after it.
  clearFileReadCache();
  if (child.error) {
    return { text: '', error: `compute command failed to start: ${child.error.message}`, unitCount: 0 };
  }
  if (child.status !== 0) {
    const tail = String(child.stderr ?? '').trim().split('\n').slice(-3).join(' | ');
    return {
      text: '',
      error: `compute command exited ${child.status ?? 'null'}${tail ? ` — ${tail}` : ''}`,
      unitCount: 0,
    };
  }
  const text = String(child.stdout ?? '');
  return { text, unitCount: text.trim() === '' ? 0 : 1 };
}

/**
 * One rule's outcome, shared by check / diff / update — and by `shrk gates
 * check`, which aggregates every plane. Exported so the aggregate runs the
 * IDENTICAL evaluation as the per-plane verb: two implementations of "did this
 * baseline drift?" would eventually disagree, and the one nobody runs would be
 * the one that is wrong.
 */
export interface IBaselineOutcome {
  readonly rule: IBaselineRule;
  readonly status: 'passed' | 'failed' | 'skipped' | 'error';
  readonly diff?: IBaselineDiff;
  readonly committed?: string;
  readonly current?: string;
  readonly committedCount: number;
  readonly currentCount: number;
  readonly error?: string;
  readonly skipReason?: string;
  /** The recompute produced 0 entries while the baseline has some — likely a broken compute. */
  readonly emptyCompute?: boolean;
  /** No committed artifact exists yet — `committed` is absent, not zero. */
  readonly missingBaseline?: boolean;
  /** Set for a `mode: 'ceiling'` rule: the measured number against its limit. */
  readonly ceiling?: ICeilingVerdict;
  /**
   * Set when the extractor compute matched a file the reader did not read
   * (over the read cap): the recomputed value is incomplete, so
   * {@link baselineCoverage} names the file and the rule is never a pass.
   */
  readonly readScope?: IReadScope;
  /**
   * Set when the rule's EMPTY result is accepted (round 13, `settleRuleEmptiness`):
   * the fence's asserted empty output (`expectEmpty: true` over live or planned
   * inputs — never over a dead one), or an intended-empty input (every
   * inclusion glob of the extractor's `source.files` marked `expectEmpty`, no
   * file matched). It stands in for the rule's coverage ({@link baselineCoverage}).
   */
  readonly emptyCoverage?: IVerdictCoverage;
  /** Settle record B of the rule's input globs (`compute.source.files` / `to.files`, `watchFiles`). */
  readonly unitAcceptance?: IVerdictCoverage;
  /** The rule's dead / intended-empty / went-live input units as printed lines. */
  readonly units?: IUnitStateLists;
  /** The rule's non-live input units, for `--fail-on-dead-units` (`selectorUnitFails`). */
  readonly unitLiveness?: readonly IUnitLiveness[];
}

/** A ledger whose recompute and committed side are both empty, in its words. */
const LEDGER_EMPTY = 'the recompute produced no entries (and the committed baseline is empty too)';
/** A ceiling over a measurement that measured nothing, in its words. */
const CEILING_EMPTY = 'the compute produced nothing — a ceiling over an empty measurement proves nothing';
/** A bless (`baseline update`) whose recompute measured nothing, in its words. */
const UPDATE_EMPTY = 'the recompute produced no entries';

/**
 * THE glob lists of a baseline's INPUTS (round 13): an extractor compute's
 * `source` (`compute.source.files`, and `to.files` for an import-edges fence)
 * and the rule's `watchFiles` — with their `expectEmpty` markers. `baseline
 * check` settles it (`settleGlobLists`) and `gates coverage` builds the same
 * request, so the two read one baseline's units alike. `primaryLists` names
 * the lists whose liveness decides the rule's emptiness — a command compute
 * has none (its `watchFiles` is a footprint, not an input it reads).
 */
export function baselineLivenessRequest(
  cwd: string,
  rule: IBaselineRule,
  excludeDirs: readonly string[],
): { readonly request: IGlobLivenessRequest; readonly primaryLists: readonly string[] } {
  const source = rule.compute.kind === 'extractor' ? rule.compute.source : undefined;
  const sources = sourceLivenessRequest(
    cwd,
    source !== undefined ? [{ label: 'compute.source', source }] : [],
    excludeDirs,
    rule.id,
  );
  const watch = rule.watchFiles ?? [];
  return {
    request: {
      subject: rule.id,
      lists: [
        ...sources.lists,
        ...(watch.length > 0
          ? [
              {
                list: 'watchFiles',
                ...(sources.lists.length > 0 ? { label: 'watchFiles' } : {}),
                globs: watch,
                units: readGlobListUnits(cwd, watch, new Set(excludeDirs)),
              },
            ]
          : []),
      ],
      marks: [...sources.marks, ...(rule.expectEmptyUnits ?? [])],
    },
    primaryLists: source !== undefined ? ['compute.source.files'] : [],
  };
}

/** The unit fields every outcome carries when the rule's inputs were settled. */
function unitFieldsOf(liveness: ISettledUnitLiveness | undefined): Pick<
  IBaselineOutcome,
  'unitAcceptance' | 'units' | 'unitLiveness'
> {
  if (liveness === undefined) return {};
  const nonLive = liveness.units.filter((u) => u.state !== UnitLivenessState.Live);
  return {
    ...(liveness.acceptance !== undefined ? { unitAcceptance: liveness.acceptance } : {}),
    ...(liveness.dead.length + liveness.intendedEmpty.length + liveness.wentLive.length > 0
      ? { units: unitStateLists(liveness) }
      : {}),
    ...(nonLive.length > 0 ? { unitLiveness: nonLive } : {}),
  };
}

/**
 * THE rule-emptiness settle of a baseline whose compute measured nothing
 * (round 13): the ledger's empty recompute, the ceiling's empty measurement
 * (P1: decided on the extractor's UNIT count, never its text — an extractor
 * serialises an empty set as `[]`, so the old text test could never fire for
 * one) and `baseline update`'s refusal all ask it. A fence (`expectEmpty:
 * true`) is accepted only over live or intended-empty inputs; over a dead
 * input it is Stale (it proves nothing).
 */
function settleBaselineEmptiness(
  rule: IBaselineRule,
  computed: IComputed,
  liveness: ISettledUnitLiveness,
  primaryLists: readonly string[],
  reason: string,
): ISettledRuleEmptiness {
  return settleRuleEmptiness({
    subject: rule.id,
    unitLabel: 'entries',
    filesMatched: computed.filesScanned ?? 0,
    unitsMatched: 0,
    unread: false,
    liveness,
    primaryLists,
    assertsEmptyOutput: ruleAssertsEmptyOutput(rule),
    failOnEmpty: failsWhenEmpty(rule),
    noFilesReason: reason,
    noUnitsReason: reason,
  });
}

/**
 * The engine entry's idempotent normalisation (round 13): the extractor
 * source's markable lists and `watchFiles` into plain lists plus their
 * `expectEmptyUnits`. A malformed marker is an errored rule, never a crash.
 */
function normalizeBaselineRule(rule: IBaselineRule): { ok: true; rule: IBaselineRule } | { ok: false; error: string } {
  const source = rule.compute.source !== undefined ? normalizeWiringSource(rule.compute.source) : undefined;
  if (source !== undefined && !source.ok) return { ok: false, error: `compute.source ${source.error.message}` };
  const withSource = source !== undefined ? { ...rule, compute: { ...rule.compute, source: source.value } } : rule;
  const watch = normalizeRuleList(withSource, 'watchFiles');
  if (!watch.ok) return { ok: false, error: `watchFiles ${watch.error.message}` };
  return { ok: true, rule: watch.value };
}

export function evaluateBaselineRule(
  cwd: string,
  authored: IBaselineRule,
  excludeDirs: readonly string[],
  changedFiles: readonly string[] | undefined,
): IBaselineOutcome {
  const normalized = normalizeBaselineRule(authored);
  if (!normalized.ok) {
    return { rule: authored, status: 'error', committedCount: 0, currentCount: 0, error: normalized.error };
  }
  const rule = normalized.rule;
  // The rule's input globs, settled with their markers (round 13) — only when
  // a unit is marked (its acceptance / went-live line rides on the outcome) or
  // the compute measured nothing (what the empty rule is decided from).
  const marked =
    (rule.expectEmptyUnits?.length ?? 0) > 0 || (rule.compute.source?.expectEmptyUnits?.length ?? 0) > 0;
  let input: { readonly liveness: ISettledUnitLiveness; readonly primaryLists: readonly string[] } | undefined;
  const inputOf = (): { readonly liveness: ISettledUnitLiveness; readonly primaryLists: readonly string[] } => {
    if (input === undefined) {
      const built = baselineLivenessRequest(cwd, rule, excludeDirs);
      input = { liveness: settleGlobLists(built.request), primaryLists: built.primaryLists };
    }
    return input;
  };
  const markedFields = (): Pick<IBaselineOutcome, 'unitAcceptance' | 'units' | 'unitLiveness'> =>
    marked ? unitFieldsOf(inputOf().liveness) : {};
  // --changed-only is honest about what it CANNOT scope: a command compute with
  // no `watchFiles` has no file footprint, so it is reported as skipped rather
  // than quietly passing.
  if (changedFiles !== undefined) {
    const globs =
      rule.watchFiles && rule.watchFiles.length > 0
        ? rule.watchFiles
        : rule.compute.kind === 'extractor'
          ? (resolveSourceGlobs(rule.compute.source ?? { files: [] }))
          : undefined;
    if (globs === undefined) {
      return {
        rule,
        status: 'skipped',
        committedCount: 0,
        currentCount: 0,
        skipReason: 'command compute with no `watchFiles` cannot be scoped to a changeset',
      };
    }
    // One list (watchFiles, else the extractor's files): a changed file the
    // list EXCLUDES cannot move the value, so it does not select the rule.
    if (!changedFiles.some((f) => globListSelects(f, globs))) {
      return {
        rule,
        status: 'skipped',
        committedCount: 0,
        currentCount: 0,
        skipReason: 'no watched file changed',
      };
    }
  }

  // A ceiling rule pins a NUMBER declared in the config, so it has no committed
  // artifact to read and no entry diff to compute — the comparison is the whole
  // check. Branching here (rather than in a parallel engine) keeps `baseline
  // check`, `gates check` and `quality` running the identical evaluation.
  if (rule.mode === 'ceiling') {
    const computed = computeCurrent(cwd, rule, excludeDirs);
    if (computed.error) {
      return { rule, status: 'error', committedCount: 0, currentCount: 0, error: computed.error, ...markedFields() };
    }
    const value = ceilingValue(rule, computed.text);
    // A compute that MEASURED nothing measured nothing. Reporting `0 ≤ 200` as
    // a pass is how a broken extractor greens a ratchet forever. Decided on the
    // UNIT count (round 13, P1 — an extractor serialises its empty set as `[]`,
    // so the old `text.trim() === ''` test could never fire for one) through
    // THE rule-emptiness settle, the one `gates coverage` reads too.
    if (computed.unitCount === 0 && !readScopeHasUnread(computed.readScope)) {
      const { liveness, primaryLists } = inputOf();
      const emptiness = settleBaselineEmptiness(rule, computed, liveness, primaryLists, CEILING_EMPTY);
      if (emptiness.skipped) {
        return {
          rule,
          status: emptiness.fails ? 'failed' : 'skipped',
          current: computed.text,
          committedCount: rule.ceiling ?? 0,
          currentCount: 0,
          skipReason: emptiness.skipReason ?? CEILING_EMPTY,
          ...unitFieldsOf(liveness),
        };
      }
      // Accepted: the rule asserts an empty output (`expectEmpty: true` is
      // honoured on a ceiling) or every input glob is intended-empty. The
      // ceiling is still judged — on the measured 0.
      const judged = evaluateCeiling(rule, value);
      return {
        rule,
        status: judged.failed ? 'failed' : 'passed',
        current: computed.text,
        committedCount: judged.ceiling,
        currentCount: judged.value,
        ceiling: judged,
        ...(!judged.failed && emptiness.coverage !== undefined ? { emptyCoverage: emptiness.coverage } : {}),
        ...unitFieldsOf(liveness),
      };
    }
    const verdict = evaluateCeiling(rule, value);
    return {
      rule,
      status: verdict.failed ? 'failed' : 'passed',
      current: computed.text,
      committedCount: verdict.ceiling,
      currentCount: verdict.value,
      ceiling: verdict,
      // An unread file makes the measurement a lower bound: over the ceiling
      // is still a real failure, under it is not verified.
      ...(computed.readScope ? { readScope: computed.readScope } : {}),
      ...markedFields(),
    };
  }

  const abs = nodePath.resolve(cwd, rule.baseline!);
  if (!existsSync(abs)) {
    // No artifact yet. `check` must still fail (nothing to compare against),
    // but the CURRENT side is knowable and is exactly what the author needs to
    // see before blessing — so compute it rather than reporting a false `0`.
    const first = computeCurrent(cwd, rule, excludeDirs);
    return {
      rule,
      status: 'error',
      committedCount: 0,
      ...(first.error ? {} : { current: first.text }),
      currentCount: first.error ? 0 : baselineCount(rule, first.text),
      missingBaseline: true,
      error:
        first.error ??
        `committed baseline ${rule.baseline} does not exist — create it with \`shrk baseline update --id ${rule.id}\``,
    };
  }
  let committed: string;
  try {
    committed = readFileSync(abs, 'utf8');
  } catch (e) {
    return {
      rule,
      status: 'error',
      committedCount: 0,
      currentCount: 0,
      error: `could not read ${rule.baseline}: ${(e as Error).message}`,
    };
  }

  const computed = computeCurrent(cwd, rule, excludeDirs);
  if (computed.error) {
    return { rule, status: 'error', committed, committedCount: 0, currentCount: 0, error: computed.error };
  }

  const committedCount = baselineCount(rule, committed);
  const currentCount = baselineCount(rule, computed.text);

  // A recompute that produced NOTHING compared nothing — and left as a pass it
  // would "match" an empty baseline forever, the silent-green this plane exists
  // to prevent. But this only holds when the COMMITTED side is empty too: if
  // the baseline has entries and the recompute has none, that is real drift
  // (everything vanished) and must be reported as such, not swallowed as a skip.
  const readScope = computed.readScope ? { readScope: computed.readScope } : {};
  if (currentCount === 0 && committedCount === 0) {
    // An empty recompute over a file the reader could not read is not "matched
    // nothing": PARTIAL (the coverage names the file), never failOnEmpty's
    // failure and never a pass.
    if (readScopeHasUnread(computed.readScope)) {
      return {
        rule,
        status: 'passed',
        committed,
        current: computed.text,
        committedCount,
        currentCount,
        ...readScope,
        ...markedFields(),
      };
    }
    // THE rule-emptiness settle (round 13). A FENCE (`expectEmpty: true`)
    // asserts the empty OUTPUT, so over live (or intended-empty) inputs its
    // empty set is the verified pass — otherwise the rule could never be green.
    // Over a DEAD input it proves nothing: Stale, and failOnEmpty's 1 (V2 f1d:
    // it used to be accepted). An extractor whose every source glob is marked
    // `expectEmpty` and matched no file is intended-empty, accepted. Anything
    // else is the loud skip it always was.
    const { liveness, primaryLists } = inputOf();
    const emptiness = settleBaselineEmptiness(rule, computed, liveness, primaryLists, LEDGER_EMPTY);
    if (!emptiness.skipped) {
      return {
        rule,
        status: 'passed',
        committed,
        current: computed.text,
        committedCount,
        currentCount,
        ...(emptiness.coverage !== undefined ? { emptyCoverage: emptiness.coverage } : {}),
        ...unitFieldsOf(liveness),
      };
    }
    return {
      rule,
      status: emptiness.fails ? 'failed' : 'skipped',
      committed,
      current: computed.text,
      committedCount,
      currentCount,
      skipReason: emptiness.skipReason ?? LEDGER_EMPTY,
      ...unitFieldsOf(liveness),
    };
  }

  const diff = diffBaseline(rule, committed, computed.text);
  return {
    rule,
    status: baselineFails(rule, diff) ? 'failed' : 'passed',
    diff,
    committed,
    current: computed.text,
    committedCount,
    currentCount,
    // A total wipe is far more often a broken compute than a real emptying —
    // say so next to the diff so it is not blessed by reflex.
    ...(currentCount === 0 ? { emptyCompute: true } : {}),
    ...readScope,
    ...markedFields(),
  };
}

/**
 * What one baseline rule examined — shared by `baseline check` and the
 * aggregate (`gates check`, `quality`), so both report the same scope.
 *
 * A ledger examines the union of its committed and recomputed entries; a
 * ceiling examines one measurement. A fence (`expectEmpty`) over an empty set
 * is the asserted state, so its empty scope is ACCEPTED by that field — and
 * printed as accepted, never silent. A skipped or errored rule examined nothing.
 *
 * An extractor compute that matched a file the reader did not read folds it
 * in through `readScopeCoverage`, the one rule every plane uses: the record
 * becomes `examined N of M files`, naming the unread file.
 */
export function baselineCoverage(o: IBaselineOutcome): IVerdictCoverage {
  return readScopeCoverage(planeBaselineCoverage(o), o.readScope);
}

function planeBaselineCoverage(o: IBaselineOutcome): IVerdictCoverage {
  // The accepted empty (round 13): the fence's asserted empty set, or an
  // intended-empty input — the rule-emptiness settle's own record, one wording
  // on every surface (`the rule asserts an empty set` / `asserted empty — …`).
  if (o.emptyCoverage !== undefined) return o.emptyCoverage;
  if (o.ceiling !== undefined) return { unit: 'measurements', expected: 1, examined: 1 };
  if (o.skipReason !== undefined) {
    return { unit: 'entries', expected: 0, examined: 0, reason: o.skipReason };
  }
  if (o.status === 'error') {
    return { unit: 'entries', expected: 0, examined: 0, reason: 'the baseline could not be evaluated' };
  }
  const size = Math.max(o.committedCount, o.currentCount);
  return { unit: 'entries', expected: size, examined: size };
}

/**
 * What this rule pins, for display. A ledger names its committed file; a
 * ceiling names the number in the config, because that IS its committed value.
 */
function pinLabel(rule: IBaselineRule): string {
  return rule.mode === 'ceiling'
    ? `ceiling ${rule.ceiling ?? 0} (sharkcraft.config.ts)`
    : (rule.baseline ?? '(no artifact)');
}

function hintFor(rule: IBaselineRule): string {
  return rule.hint ?? `review the diff, then bless it with \`shrk baseline update --id ${rule.id}\``;
}

function outcomeJson(o: IBaselineOutcome): Record<string, unknown> {
  return {
    id: o.rule.id,
    ...(o.rule.description ? { description: o.rule.description } : {}),
    ...(o.rule.baseline ? { baseline: o.rule.baseline } : {}),
    mode: o.rule.mode ?? 'ledger',
    severity: o.rule.severity ?? 'error',
    direction: o.rule.direction ?? (o.rule.mode === 'ceiling' ? 'at-most' : 'two-way'),
    ...(o.ceiling ? { ceiling: o.ceiling } : {}),
    status: o.status,
    committedCount: o.committedCount,
    currentCount: o.currentCount,
    ...(o.diff ? { diff: { added: o.diff.added, removed: o.diff.removed, mode: o.diff.mode, canonical: o.diff.canonical } } : {}),
    ...(o.error ? { error: o.error } : {}),
    ...(o.skipReason ? { skipReason: o.skipReason } : {}),
    ...(o.emptyCompute ? { emptyCompute: true } : {}),
    ...(o.missingBaseline ? { missingBaseline: true } : {}),
    hint: hintFor(o.rule),
  };
}

/** Print one outcome's ±diff, capped so a huge drift stays readable. */
function writeDiff(o: IBaselineOutcome, cap = 25): void {
  if (!o.diff) return;
  for (const a of o.diff.added.slice(0, cap)) process.stdout.write(`      + ${a}\n`);
  if (o.diff.added.length > cap) process.stdout.write(`      + … (${o.diff.added.length - cap} more)\n`);
  for (const r of o.diff.removed.slice(0, cap)) process.stdout.write(`      - ${r}\n`);
  if (o.diff.removed.length > cap) process.stdout.write(`      - … (${o.diff.removed.length - cap} more)\n`);
}

/** Shared prologue: load config, select rules, resolve the changed scope. */
async function prepare(
  args: ParsedArgs,
  opts: { changedAware: boolean; rejectedKnown?: boolean },
): Promise<
  | {
      ok: true;
      cwd: string;
      rules: readonly IBaselineRule[];
      all: readonly IBaselineRule[];
      excludeDirs: string[];
      changedFiles?: readonly string[];
      planeDiagnostics: readonly string[];
      /** Merge-seam-rejected pack baselines, narrowed by `--id` (round 12 review, R12-X1). */
      rejected: readonly IGateRuleResult[];
    }
  | { ok: false; code: number }
> {
  const cwd = resolveCwd(args);
  const json = flagBool(args, 'json');
  const loaded = await loadBaselines(cwd);
  if (!loaded.ok) {
    if (json) process.stdout.write(asJson({ schema: SCHEMA, error: loaded.message }) + '\n');
    else process.stderr.write(`Could not load config: ${loaded.message}\n  Run \`shrk doctor\` for details.\n`);
    return { ok: false, code: ExitCode.UsageError };
  }
  const idFlag = flagString(args, 'id') ?? undefined;
  // A verdict verb may select a rejected baseline by id (its errored row); a
  // verb that acts on a rule (update / diff / explain) cannot — there is none.
  const rejectedKnown = opts.rejectedKnown === true ? loaded.value.rejected.map((r) => r.id) : [];
  const selected = selectRules(loaded.value.rules, idFlag, rejectedKnown);
  const wantedIds = idFlag ? idFlag.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const rejected = wantedIds ? loaded.value.rejected.filter((r) => wantedIds.includes(r.id)) : loaded.value.rejected;
  if (!selected.ok) {
    process.stderr.write(selected.message + '\n');
    return { ok: false, code: ExitCode.UsageError };
  }
  let changedFiles: readonly string[] | undefined;
  if (opts.changedAware) {
    const since = flagString(args, 'since');
    if (flagBool(args, 'changed-only') || since) {
      changedFiles = resolveChangedFiles({
        projectRoot: cwd,
        ...(since ? { since } : {}),
        ...(!since ? { includeWorktree: true } : {}),
      }).files;
    }
  }
  return {
    ok: true,
    cwd,
    rules: selected.rules,
    all: loaded.value.rules,
    excludeDirs: loaded.value.sharkcraftDirRel ? [loaded.value.sharkcraftDirRel] : [],
    ...(changedFiles !== undefined ? { changedFiles } : {}),
    planeDiagnostics: loaded.value.planeDiagnostics,
    rejected,
  };
}

/** `  ✗ <id>  REJECTED — <why>` — a pack rule the merge seam refused (declared, never run). */
function writeRejected(rejected: readonly IGateRuleResult[]): void {
  for (const r of rejected) process.stdout.write(`  ✗ ${r.id}  REJECTED — ${r.error ?? 'failed validation'}\n`);
}

/**
 * The "no baselines declared" landing, shared by every subverb. A VERDICT verb
 * passes its name so its JSON still carries the settled `gate` envelope —
 * nothing declared is `2`, never a pass.
 */
function writeNoRules(json: boolean, verb?: string): number {
  // A VERDICT verb settles first and renders second, in text AND JSON: nothing
  // declared proposes 0 and the run coverage (expected 0) settles it to 2. The
  // exit comes from the envelope — never a hard-coded code — so text, JSON and
  // gate.exit cannot disagree. List / explain subverbs stay informational.
  const gate =
    verb !== undefined
      ? buildGateEnvelope(verb, ExitCode.VerifiedPass, [], {
          unit: 'baselines',
          expected: 0,
          examined: 0,
          reason: 'no baselines[] declared',
        })
      : undefined;
  const exit = gate?.exit ?? ExitCode.NotVerified;
  if (json) {
    process.stdout.write(
      asJson({
        schema: SCHEMA,
        results: [],
        evaluated: 0,
        verdict: gate ? planeVerdictForExit(gate.exit) : 'not-verified',
        ...(gate ? { exitCode: gate.exit, gate } : {}),
      }) + '\n',
    );
    return exit;
  }
  process.stdout.write(header('Baselines'));
  process.stdout.write(
    '  No baselines declared. Add `baselines[]` to sharkcraft.config.ts to replace a\n' +
      '  hand-rolled "committed file + recompute script + drift test" trio with one\n' +
      '  two-way engine (see docs/baseline-drift.md).\n',
  );
  if (gate) {
    const line = verdictLine(gate, 'Nothing declared — accepted.');
    if (line) process.stdout.write(`\n${line}\n`);
  }
  return exit;
}

export const baselineListCommand: ICommandHandler = {
  name: 'list',
  description: 'List every declared baseline: what it pins, how it recomputes, which direction fails.',
  usage: 'shrk baseline list [--json]',
  booleanFlags: new Set(['json']),
  async run(args: ParsedArgs): Promise<number> {
    const prep = await prepare(args, { changedAware: false });
    if (!prep.ok) return prep.code;
    const json = flagBool(args, 'json');
    if (prep.all.length === 0 && prep.rejected.length === 0) return writeNoRules(json);
    if (json) {
      process.stdout.write(
        asJson({
          schema: SCHEMA,
          // Declared by a pack, refused by the merge seam: never computed.
          rejected: prep.rejected.map((r) => ({ id: r.id, error: r.error ?? null })),
          baselines: prep.all.map((r) => ({
            id: r.id,
            description: r.description ?? null,
            baseline: r.baseline,
            compute: r.compute.kind,
            direction: r.direction ?? 'two-way',
            keyBy: r.keyBy ?? null,
            // The EFFECTIVE failOnEmpty (round 13) — THE authority, never the
            // raw field: an error rule fails on empty by default.
            failOnEmpty: failsWhenEmpty(r),
          })),
          diagnostics: prep.planeDiagnostics,
        }) + '\n',
      );
      return ExitCode.VerifiedPass;
    }
    process.stdout.write(header(`Baselines (${prep.all.length})`));
    for (const r of prep.all) {
      process.stdout.write(`  • ${r.id}  →  ${r.baseline}\n`);
      process.stdout.write(
        `      compute ${r.compute.kind}${r.compute.kind === 'command' ? ` (${r.compute.run})` : ''}` +
          `  ·  direction ${r.direction ?? 'two-way'}${r.keyBy ? `  ·  keyBy ${r.keyBy}` : ''}` +
          `${failsWhenEmpty(r) ? '  ·  failOnEmpty' : ''}\n`,
      );
      if (r.description) process.stdout.write(`      ${r.description}\n`);
    }
    if (prep.rejected.length > 0) {
      process.stdout.write(`\n  rejected at the pack-plane merge seam — never computed (${prep.rejected.length}):\n`);
      writeRejected(prep.rejected);
    }
    for (const d of prep.planeDiagnostics) process.stdout.write(`  ! ${d}\n`);
    return ExitCode.VerifiedPass;
  },
};

export const baselineCheckCommand: ICommandHandler = {
  name: 'check',
  description:
    'Recompute every declared baseline and fail on drift. Two-way by default — a LOST entry fails exactly like a gained one.',
  usage: 'shrk baseline check [--id <ids>] [--changed-only] [--since <ref>] [--json]',
  booleanFlags: new Set(['json', 'changed-only']),
  async run(args: ParsedArgs): Promise<number> {
    const prep = await prepare(args, { changedAware: true, rejectedKnown: true });
    if (!prep.ok) return prep.code;
    const json = flagBool(args, 'json');
    // A pack baseline the merge seam rejected is a declared baseline that was
    // never computed — an errored row, exit 1 (round 12 review, R12-X1).
    const rejected = prep.rejected;
    if (prep.rules.length === 0 && rejected.length === 0) return writeNoRules(json, 'baseline check');

    const outcomes = prep.rules.map((r) =>
      evaluateBaselineRule(prep.cwd, r, prep.excludeDirs, prep.changedFiles),
    );
    const failed = outcomes.filter(
      (o) => o.status === 'failed' || (o.status === 'error' && (o.rule.severity ?? 'error') === 'error'),
    );
    const evaluated = outcomes.filter((o) => o.status !== 'skipped').length;
    // 0 only when a NON-EMPTY scope was actually compared; 2 when nothing was.
    // A skipped baseline is "partially verified", never a green 0.
    const skippedCount = outcomes.filter((o) => o.status === 'skipped').length;
    const proposed =
      failed.length > 0 || rejected.length > 0
        ? ExitCode.Failure
        : evaluated === 0 || skippedCount > 0
          ? ExitCode.NotVerified
          : ExitCode.VerifiedPass;
    // Settle first, render second: one envelope for text AND JSON, and the ✓
    // line is printed only from the settled verdict.
    const unexamined = [
      ...outcomes.filter((o) => o.status === 'skipped' || o.status === 'error').map((o) => o.rule.id),
      ...rejected.map((r) => r.id),
    ];
    const env = buildGateEnvelope(
      'baseline check',
      proposed,
      [...outcomes.map((o) => ({
        id: o.rule.id,
        type: 'baseline' as const,
        status: o.status,
        severity: o.rule.severity ?? 'error',
        counts: { committed: o.committedCount, current: o.currentCount },
        violations: [
          ...(o.diff?.added ?? []).map((id) => ({ id, message: 'added', hint: hintFor(o.rule) })),
          ...(o.diff?.removed ?? []).map((id) => ({ id, message: 'removed', hint: hintFor(o.rule) })),
        ],
        ...(o.skipReason ? { skipReason: o.skipReason } : {}),
        ...(o.error ? { error: o.error } : {}),
        coverage: baselineCoverage(o),
        // The rule's `expectEmpty` acceptance and unit lines (round 13), folded
        // into the envelope's one settle.
        ...(o.unitAcceptance !== undefined ? { unitAcceptance: o.unitAcceptance } : {}),
        ...(o.units !== undefined ? { units: o.units } : {}),
      })), ...rejected],
      {
        unit: 'baselines',
        expected: outcomes.length + rejected.length,
        examined: outcomes.length + rejected.length - unexamined.length,
        ...(unexamined.length > 0 ? { unexamined, reason: 'compared nothing or could not run' } : {}),
      },
    );
    const exit = env.exit;

    if (json) {
      process.stdout.write(
        asJson({
          schema: SCHEMA,
          results: outcomes.map(outcomeJson),
          // Pack baselines the merge seam refused — errored rows in `gate.rules`.
          rejected: rejected.map((r) => ({ id: r.id, error: r.error ?? null })),
          evaluated,
          skipped: skippedCount,
          verdict: exit === ExitCode.Failure ? 'errors' : exit === ExitCode.VerifiedPass ? 'pass' : 'not-verified',
          diagnostics: prep.planeDiagnostics,
          exitCode: exit,
          gate: env,
        }) + '\n',
      );
      return exit;
    }

    process.stdout.write(header('Baseline drift'));
    // Round 13 (K6): the printed count is the envelope's (`gate.evaluated`), which
    // never counts a rule accepted as intended-empty — it is named apart.
    process.stdout.write(
      kv(
        'evaluated',
        `${env.evaluated} of ${prep.rules.length + rejected.length}${acceptedEmptyNote(env.acceptedEmpty)}` +
          (rejected.length > 0 ? ` (${rejected.length} rejected at the pack-plane merge seam — NOT evaluated)` : ''),
      ) + '\n',
    );
    writeRejected(rejected);
    for (const o of outcomes) {
      if (o.status === 'passed') {
        // Rendered from the SETTLED rule: a pass over part of its scope is
        // `partial`, never a ✓ (the keystone emitter pattern, step 5).
        const settledRule = env.rules.find((x) => x.id === o.rule.id);
        process.stdout.write(
          settledRule?.status === 'partial'
            ? `  ~ ${o.rule.id}  PARTIAL — ${settledRule.shortfall ?? 'part of its scope was not examined'}\n`
            : o.ceiling
              ? `  ✓ ${o.rule.id}  (${o.ceiling.value} ${o.ceiling.direction} ${o.ceiling.ceiling} — ${o.ceiling.slack} to spare)\n`
              : `  ✓ ${o.rule.id}  (${o.currentCount} entries, no drift)\n`,
        );
        continue;
      }
      if (o.status === 'skipped') {
        process.stdout.write(`  – ${o.rule.id}  SKIPPED — ${o.skipReason}\n`);
        continue;
      }
      if (o.status === 'error') {
        process.stdout.write(`  ! ${o.rule.id}  ${o.error}\n`);
        if (o.missingBaseline && o.currentCount > 0) {
          process.stdout.write(
            `      the compute currently yields ${o.currentCount} entr${o.currentCount === 1 ? 'y' : 'ies'} — ` +
              `run \`shrk baseline update --id ${o.rule.id}\` to bless them.\n`,
          );
        }
        continue;
      }
      // A rule that measured nothing and FAILS on it (failOnEmpty, or a fence
      // over a dead input) has no diff — its reason is the only true line. It is
      // never rendered as DRIFT with a bless hint (round 13, P1): blessing it
      // would commit the empty measurement the loud skip refused.
      if (o.status === 'failed' && o.skipReason !== undefined) {
        process.stdout.write(`  ✗ ${o.rule.id}  FAILED — ${o.skipReason}\n`);
        if (!ruleAssertsEmptyOutput(o.rule)) {
          process.stdout.write(`      → ${formatEmptyRuleAdvice({ fails: true })}\n`);
        }
        continue;
      }
      if (o.ceiling) {
        const over = -o.ceiling.slack;
        process.stdout.write(
          `  ✗ ${o.rule.id}  OVER CEILING — ${o.ceiling.value} is ${over} ` +
            `${o.ceiling.direction === 'at-most' ? 'above' : 'below'} the limit of ${o.ceiling.ceiling}\n` +
            `      lower the measurement, or raise the ceiling deliberately: \`shrk baseline update --id ${o.rule.id}\`\n`,
        );
        continue;
      }
      const added = o.diff?.added.length ?? 0;
      const removed = o.diff?.removed.length ?? 0;
      process.stdout.write(
        `  ✗ ${o.rule.id}  DRIFT — ${added} added, ${removed} removed ` +
          `(${o.committedCount} committed → ${o.currentCount} now, ${o.diff?.mode})\n`,
      );
      writeDiff(o);
      if (o.emptyCompute) {
        process.stdout.write(
          '      ! the recompute produced 0 entries — check the compute before blessing this.\n',
        );
      }
      process.stdout.write(`      → ${hintFor(o.rule)}\n`);
    }
    for (const d of prep.planeDiagnostics) process.stdout.write(`  ! ${d}\n`);
    // THE empty-rule advice (round 13) for a SOFT skip: a failing one is
    // advised inline (above); a rule that matched nothing and does not fail on
    // it was told nothing.
    for (const a of emptyRuleAdviceLines(
      outcomes.filter((o) => o.status === 'skipped' && o.skipReason !== undefined).map(() => ({ fails: false })),
    )) {
      process.stdout.write(`  ${a}.\n`);
    }
    // THE shared unit-state block (round 13, K2): a dead input glob — a dead
    // import-edges `to.files` under an accepted fence included — and a LOCAL
    // expectEmpty marker whose target appeared withhold the ✓ (exit
    // unchanged); a pack marker is INFO.
    const unitNotes = unitStateNotes(
      outcomes.map((o) => ({
        id: o.rule.id,
        ...(o.unitLiveness !== undefined ? { unitLiveness: o.unitLiveness } : {}),
        reportedEmpty: o.status === 'skipped' || o.skipReason !== undefined,
      })),
    );
    process.stdout.write(unitNotes.text);
    const line = verdictLine(
      env,
      qualifyCleanForUnits(
        outcomes.some((o) => o.ceiling)
          ? 'Every baseline is within its pinned value. ✓'
          : 'Every baseline matches its committed artifact. ✓',
        unitNotes,
      ),
      proposed === ExitCode.NotVerified && evaluated === 0
        ? 'Nothing was compared — this is NOT a pass. Every selected baseline was skipped.'
        : undefined,
    );
    if (line) process.stdout.write(`\n${line}\n`);
    return exit;
  },
};

export const baselineDiffCommand: ICommandHandler = {
  name: 'diff',
  description:
    'Show the +added / −removed entries for each baseline without failing — the inspection verb (always exits 0 when it ran).',
  usage: 'shrk baseline diff [--id <ids>] [--json]',
  booleanFlags: new Set(['json']),
  async run(args: ParsedArgs): Promise<number> {
    const prep = await prepare(args, { changedAware: false });
    if (!prep.ok) return prep.code;
    const json = flagBool(args, 'json');
    if (prep.rules.length === 0) return writeNoRules(json);

    const outcomes = prep.rules.map((r) => evaluateBaselineRule(prep.cwd, r, prep.excludeDirs, undefined));
    if (json) {
      process.stdout.write(
        asJson({ schema: SCHEMA, results: outcomes.map(outcomeJson), inspection: true }) + '\n',
      );
      return ExitCode.VerifiedPass;
    }
    process.stdout.write(header('Baseline diff (inspection — never fails)'));
    for (const o of outcomes) {
      const added = o.diff?.added.length ?? 0;
      const removed = o.diff?.removed.length ?? 0;
      process.stdout.write(
        `\n${o.rule.id}  (${pinLabel(o.rule)})  ` +
          (o.status === 'error'
            ? `! ${o.error}`
            : o.ceiling
              ? `${o.ceiling.value} vs ${o.ceiling.direction} ${o.ceiling.ceiling} (slack ${o.ceiling.slack})`
              : `+${added} / -${removed}`) +
          '\n',
      );
      writeDiff(o, 100);
    }
    return ExitCode.VerifiedPass;
  },
};

export const baselineUpdateCommand: ICommandHandler = {
  name: 'update',
  description:
    'Rewrite the committed baseline from the current value — the explicit, reviewable bless step. Writes files.',
  usage: 'shrk baseline update [--id <ids>] [--dry-run] [--json]',
  booleanFlags: new Set(['json', 'dry-run']),
  async run(args: ParsedArgs): Promise<number> {
    const prep = await prepare(args, { changedAware: false });
    if (!prep.ok) return prep.code;
    const json = flagBool(args, 'json');
    const dryRun = flagBool(args, 'dry-run');
    if (prep.rules.length === 0) return writeNoRules(json);

    const written: { id: string; path: string; bytes: number; changed: boolean }[] = [];
    const errors: { id: string; error: string }[] = [];
    // A ceiling's pinned value lives in `sharkcraft.config.ts`, so blessing it
    // is a config edit, not a file write. `update` prints the exact one-line
    // change instead of touching the config — the same explicit, reviewable
    // bless, without this command growing the ability to rewrite the rules it
    // is enforcing.
    const reblessed: { id: string; from: number; to: number; edit: string }[] = [];
    // A value recomputed from an incomplete read (a file over the read cap)
    // misses whatever the unread file holds. Blessing it would commit a number
    // the loud-skip rule forbids reporting, and the next `baseline check`
    // would be NOT VERIFIED anyway. So the rule is refused and named, and the
    // run settles NOT VERIFIED (2), never "wrote … (exit 0)".
    const unverified: { id: string; shortfall: string; unread: readonly string[] }[] = [];
    const unverifiedCoverage: IVerdictCoverage[] = [];
    // Round 13 (K9): ceilings whose measurement is an EMPTY one the settle does
    // not accept — the loud skip `baseline check` reports, never a proposal.
    const emptyCeilings: { id: string; reason: string }[] = [];
    for (const rule of prep.rules) {
      const computed = computeCurrent(prep.cwd, rule, prep.excludeDirs);
      if (computed.error) {
        errors.push({ id: rule.id, error: computed.error });
        continue;
      }
      if (readScopeHasUnread(computed.readScope)) {
        const record: IVerdictCoverage = {
          ...readScopeCoverage({ unit: 'baseline entries', expected: 1, examined: 1 }, computed.readScope),
          subject: rule.id,
        };
        unverifiedCoverage.push(record);
        unverified.push({
          id: rule.id,
          shortfall: coverageShortfall(record) ?? '',
          unread: (computed.readScope?.unread ?? []).map((u) => u.path),
        });
        continue;
      }
      if (rule.mode === 'ceiling') {
        // K9: never propose `ceiling: <measured>` over an EMPTY measurement.
        // THE rule-emptiness settle `baseline check` reads decides it (on the
        // extractor's UNIT count): an accepted empty (a fence, an intended-
        // empty input) is judged like any value; a stale one is the loud skip
        // — 2 NOT VERIFIED, or 1 under failOnEmpty — never `ceiling: 0`.
        if (computed.unitCount === 0) {
          const input = baselineLivenessRequest(prep.cwd, rule, prep.excludeDirs);
          const emptiness = settleBaselineEmptiness(
            rule,
            computed,
            settleGlobLists(input.request),
            input.primaryLists,
            CEILING_EMPTY,
          );
          if (emptiness.skipped) {
            const reason = emptiness.skipReason ?? CEILING_EMPTY;
            if (emptiness.fails) {
              errors.push({
                id: rule.id,
                error: `refusing to propose a ceiling from an EMPTY measurement for a \`failOnEmpty\` rule — ${reason} — fix the compute first`,
              });
            } else {
              unverifiedCoverage.push({ unit: 'measurements', expected: 1, examined: 0, subject: rule.id, reason });
              emptyCeilings.push({ id: rule.id, reason });
            }
            continue;
          }
        }
        const value = ceilingValue(rule, computed.text);
        reblessed.push({
          id: rule.id,
          from: rule.ceiling ?? 0,
          to: value,
          edit: `ceiling: ${value},   // was ${rule.ceiling ?? 0}`,
        });
        continue;
      }
      // An EMPTY bless is decided by the compute's UNIT count and THE
      // rule-emptiness settle `baseline check` reads (round 13, P1) — never by
      // its text: an extractor serialises its empty set as `[]`, so the old
      // `text.trim() === ''` test never refused one, and a failOnEmpty ledger
      // over a dead selector was blessed empty. A fence's asserted-empty output
      // over live inputs, or an intended-empty input, is blessable; a stale
      // empty (a dead or unmarked selector, files that yielded nothing) of a
      // failOnEmpty rule is refused, naming why.
      if (computed.unitCount === 0) {
        const input = baselineLivenessRequest(prep.cwd, rule, prep.excludeDirs);
        const liveness = settleGlobLists(input.request);
        // Name the dead input the settle found (its own `.dead` lines), so the
        // refusal says WHICH selector to fix.
        const deadInputs = liveness.dead.map((u) => `${u.label}: ${u.deadReason ?? 'matched 0 files'}`);
        const reason =
          deadInputs.length > 0
            ? `${UPDATE_EMPTY} — its input selector matched nothing (${deadInputs.join('; ')})`
            : UPDATE_EMPTY;
        const emptiness = settleBaselineEmptiness(rule, computed, liveness, input.primaryLists, reason);
        if (emptiness.skipped && emptiness.fails) {
          errors.push({
            id: rule.id,
            error:
              'refusing to write an EMPTY baseline for a `failOnEmpty` rule — ' +
              `${emptiness.skipReason ?? reason} — fix the compute first`,
          });
          continue;
        }
      }
      const abs = nodePath.resolve(prep.cwd, rule.baseline!);
      const previous = existsSync(abs) ? readFileSync(abs, 'utf8') : undefined;
      const changed = previous !== computed.text;
      if (!dryRun && changed) {
        mkdirSync(nodePath.dirname(abs), { recursive: true });
        writeFileSync(abs, computed.text, 'utf8');
      }
      written.push({ id: rule.id, path: rule.baseline!, bytes: computed.text.length, changed });
    }

    const settled = settleVerdict(errors.length > 0 ? ExitCode.Failure : ExitCode.VerifiedPass, unverifiedCoverage);
    const exit = settled.exit;
    if (json) {
      process.stdout.write(
        asJson({
          schema: SCHEMA,
          dryRun,
          written,
          reblessed,
          errors,
          ...(unverified.length > 0 ? { unverified } : {}),
          // K9: a ceiling over an empty measurement is the loud skip, never a
          // proposal — named here with the reason `baseline check` prints.
          ...(emptyCeilings.length > 0 ? { skipped: emptyCeilings } : {}),
          ...(unverified.length > 0 || emptyCeilings.length > 0 ? { shortfalls: settled.shortfalls } : {}),
          exitCode: exit,
        }) + '\n',
      );
      return exit;
    }
    process.stdout.write(header(dryRun ? 'Baseline update (dry run)' : 'Baseline update'));
    for (const w of written) {
      process.stdout.write(
        `  ${w.changed ? (dryRun ? 'would write' : 'wrote') : 'unchanged '} ${w.path}  (${w.bytes} bytes)\n`,
      );
    }
    for (const r of reblessed) {
      const verb = r.from === r.to ? 'unchanged ' : 'edit config';
      process.stdout.write(`  ${verb} ${r.id}  (ceiling ${r.from} → ${r.to})\n`);
      if (r.from !== r.to) process.stdout.write(`             ${r.edit}\n`);
    }
    for (const e of errors) process.stdout.write(`  ! ${e.id}: ${e.error}\n`);
    for (const u of unverified) {
      process.stdout.write(`  ! ${u.id}: not written — computed from an incomplete read (${u.unread.join(', ')})\n`);
    }
    for (const s of emptyCeilings) {
      process.stdout.write(`  – ${s.id}: no ceiling proposed — ${s.reason}\n`);
    }
    if (reblessed.some((r) => r.from !== r.to)) {
      process.stdout.write(
        '\nA ceiling lives in sharkcraft.config.ts — apply the line above by hand so raising it stays a reviewed diff.\n',
      );
    }
    if (written.some((w) => w.changed) && !dryRun) {
      process.stdout.write('\nReview the diff before committing — this is the bless step.\n');
    }
    const line = verdictLine(
      settled,
      '',
      unverified.length > 0
        ? 'Nothing was blessed for the baseline(s) above: their value came from an incomplete read.'
        : emptyCeilings.length > 0
          ? 'No ceiling was proposed for the baseline(s) above: their measurement was empty — fix the compute, or mark a planned input { pattern, expectEmpty: true }.'
          : undefined,
    );
    if (line) process.stdout.write(`\n${line}\n`);
    return exit;
  },
};

export const baselineExplainCommand: ICommandHandler = {
  name: 'explain',
  description:
    'Show what ONE baseline will compute and compare — the command or extractor, the canonical form, both entry counts and the diff — without turning it into a verdict.',
  usage: 'shrk baseline explain --id <id> [--json]',
  booleanFlags: new Set(['json']),
  async run(args: ParsedArgs): Promise<number> {
    const id = flagString(args, 'id') ?? args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk baseline explain --id <id>\n');
      return ExitCode.UsageError;
    }
    const prep = await prepare(args, { changedAware: false });
    if (!prep.ok) return prep.code;
    const rule = prep.all.find((r) => r.id === id);
    if (!rule) {
      process.stderr.write(
        `No baseline "${id}". Declared: ${prep.all.map((r) => r.id).join(', ') || '(none)'}\n`,
      );
      return ExitCode.UsageError;
    }
    const outcome = evaluateBaselineRule(prep.cwd, rule, prep.excludeDirs, undefined);
    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({
          schema: 'sharkcraft.baseline-explain/v1',
          ...outcomeJson(outcome),
          compute: rule.compute,
          watchFiles: rule.watchFiles ?? null,
        }) + '\n',
      );
      return ExitCode.VerifiedPass;
    }
    process.stdout.write(header(`Baseline: ${rule.id}`));
    if (rule.description) process.stdout.write(`  ${rule.description}\n`);
    process.stdout.write(kv('committed', pinLabel(rule)) + '\n');
    process.stdout.write(
      kv(
        'compute',
        rule.compute.kind === 'command'
          ? `command · ${rule.compute.run}`
          : `extractor · ${rule.compute.source?.extract ?? 'sugar'}` +
            (rule.compute.source?.$use ? `  (via $use:${rule.compute.source.$use})` : ''),
      ) + '\n',
    );
    process.stdout.write(
      kv('direction', rule.direction ?? (rule.mode === 'ceiling' ? 'at-most' : 'two-way')) + '\n',
    );
    process.stdout.write(kv('canonical', outcome.diff?.canonical ?? rule.compute.canonical ?? 'auto') + '\n');
    if (rule.keyBy) process.stdout.write(kv('keyBy', rule.keyBy) + '\n');
    process.stdout.write(
      kv(
        outcome.ceiling ? 'measured' : 'entries',
        outcome.ceiling
          ? `${outcome.ceiling.value} ${outcome.ceiling.direction} ${outcome.ceiling.ceiling}` +
            `  (${outcome.ceiling.slack >= 0 ? `${outcome.ceiling.slack} to spare` : `${-outcome.ceiling.slack} over`})`
          : outcome.missingBaseline
            ? `committed (none yet) → ${outcome.currentCount} now`
            : `${outcome.committedCount} committed → ${outcome.currentCount} now`,
      ) + '\n',
    );
    process.stdout.write(kv('status', outcome.status) + '\n');
    if (outcome.error) process.stdout.write(`  ! ${outcome.error}\n`);
    if (outcome.skipReason) process.stdout.write(`  – ${outcome.skipReason}\n`);
    if (outcome.diff && (outcome.diff.added.length > 0 || outcome.diff.removed.length > 0)) {
      process.stdout.write('\n  diff:\n');
      writeDiff(outcome, 100);
    }
    return ExitCode.VerifiedPass;
  },
};

export const baselineCommand: ICommandHandler = {
  name: 'baseline',
  description:
    'Committed-baseline drift engine: recompute a ledger/digest/allow-list and fail on drift in BOTH directions. Read-only except `update`.',
  usage: 'shrk baseline list | check | diff | update | explain --id <id>',
  // Every subverb is a registered trie child; any other bare token is refused
  // by the dispatcher guard (closest match named) before this body runs — the
  // one unknown-subcommand authority. Only a bare `shrk baseline` lands here.
  positionals: PositionalMode.None,
  booleanFlags: new Set(['json', 'changed-only', 'dry-run']),
  async run(): Promise<number> {
    process.stderr.write('Usage: shrk baseline list | check [--id X] | diff | update | explain --id <id>\n');
    return ExitCode.UsageError;
  },
};
