/**
 * `shrk generated {list,check,update,explain}` — the generated-artifact drift +
 * provenance GATE. It shares the `generated` noun with the classifier verbs
 * (`report` / `protect`, in `ingest.command.ts`) on purpose: that half FINDS
 * what is generated, this half proves it has not drifted.
 *
 *   shrk generated list                       # every declared artifact set
 *   shrk generated check [--id X]             # regen → temp dir → diff BOTH ways + headers
 *       [--headers-only]                      #   header contract only; never spawns
 *   shrk generated update [--id X]            # regen → temp dir → write the ALIGNED files in place (bless)
 *   shrk generated explain --id X             # what it will run + what it currently sees
 *
 * The build compiles a hand-edited generated file perfectly happily; only
 * regenerate-into-a-temp-dir-and-diff catches the edit. `regen` therefore
 * SPAWNS a shell command, which is why the pack-plane merge seam drops any
 * pack-contributed rule declaring one — a header-only rule (no `regen`) is
 * fully useful and never spawns, so packs can still ship it.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';
import {
  failsWhenEmpty,
  formatEmptyRuleAdvice,
  normalizeRuleList,
  RuleEmptiness,
  settleRuleEmptiness,
  unitStateLists,
  UnitLivenessState,
  type IGeneratedArtifactRule,
  type IUnitLiveness,
  type IUnitStateLists,
} from '@shrkcrft/core';
import {
  checkProvenanceHeaders,
  clearFileReadCache,
  compareGeneratedTrees,
  globListSelects,
  globListWalkGlobs,
  planeScanExcludeDirs,
  readGlobListLiveness,
  readRegenTree,
  readScopeCoverage,
  readScopeHasUnread,
  scanGeneratedFiles,
  type IGeneratedFileDiff,
  type IGeneratedScan,
  type IGeneratedTreeDiff,
  type IProvenanceFinding,
  type IReadScope,
  type IUnreadFile,
} from '@shrkcrft/boundaries';
import { resolveProjectConfig } from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
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

const SCHEMA = 'sharkcraft.generated-drift/v1';
const DEFAULT_TIMEOUT_MS = 120_000;

interface ILoadedRules {
  readonly rules: readonly IGeneratedArtifactRule[];
  readonly planeDiagnostics: readonly string[];
  readonly excludeDirs: string[];
  /** Pack rules the merge seam rejected — declared, never checked (round 12 review, R12-X1). */
  readonly rejected: readonly IGateRuleResult[];
}

async function loadRules(
  cwd: string,
): Promise<{ ok: true; value: ILoadedRules } | { ok: false; message: string }> {
  const loaded = await resolveProjectConfig(cwd);
  if (!loaded.ok) return { ok: false, message: loaded.error.message };
  return {
    ok: true,
    value: {
      rules: loaded.value.config.generatedArtifacts ?? [],
      planeDiagnostics: loaded.value.planeDiagnostics,
      excludeDirs: planeScanExcludeDirs(cwd, loaded.value.sharkcraftDir),
      rejected: seamRejectedRules(loaded.value, ['generated']),
    },
  };
}

/** `  ✗ <id>  REJECTED — <why>` — a pack rule the merge seam refused (declared, never run). */
function writeRejected(rejected: readonly IGateRuleResult[]): void {
  for (const r of rejected) process.stdout.write(`  ✗ ${r.id}  REJECTED — ${r.error ?? 'failed validation'}\n`);
}

/** Number of trailing path SEGMENTS `a` and `b` share (0 when none). */
function sharedSuffixSegments(a: string, b: string): number {
  const x = a.split('/');
  const y = b.split('/');
  let n = 0;
  while (n < x.length && n < y.length && x[x.length - 1 - n] === y[y.length - 1 - n]) n += 1;
  return n;
}

/**
 * Re-key a regenerated tree onto the committed paths.
 *
 * A regen writes into `{TMP}` under its own root, which is rarely the repo
 * root, while committed files are keyed project-relative. The two sets are
 * matched on the LONGEST shared path suffix — not the first suffix that
 * happens to match, because `a.json` alone would otherwise bind to whichever
 * `…/a.json` the iteration reached first and silently compare two unrelated
 * files. Ties break lexically so the mapping is deterministic, each committed
 * path is claimed at most once, and anything unmatched keeps its temp-relative
 * key and surfaces as `only-regenerated` rather than disappearing.
 *
 * Returns temp path → key, so the outputs the reader read AND the ones it did
 * not (over the regen cap) key onto the same committed path through ONE
 * alignment.
 */
function alignKeys(tempPaths: readonly string[], committedPaths: readonly string[]): Map<string, string> {
  const targets = [...new Set(committedPaths)].sort();
  const claimed = new Set<string>();
  const out = new Map<string, string>();
  // Best-match first: a temp path with a longer shared suffix has the stronger
  // claim on a committed path, so resolve those before the weaker ones.
  const scored = [...tempPaths]
    .map((tempPath) => {
      let best: { path: string; score: number } | undefined;
      for (const c of targets) {
        const score = sharedSuffixSegments(tempPath, c);
        if (score > 0 && (best === undefined || score > best.score)) best = { path: c, score };
      }
      return { tempPath, best };
    })
    .sort((a, b) => (b.best?.score ?? 0) - (a.best?.score ?? 0) || a.tempPath.localeCompare(b.tempPath));

  for (const { tempPath, best } of scored) {
    if (best && !claimed.has(best.path)) {
      claimed.add(best.path);
      out.set(tempPath, best.path);
    } else {
      out.set(tempPath, tempPath);
    }
  }
  return out;
}

interface IRegenResult {
  readonly files?: ReadonlyMap<string, string>;
  /**
   * Outputs the regen wrote that the reader did NOT read (over the regen cap,
   * or unreadable), keyed exactly like `files`. Never dropped: the caller
   * decides whether one is uncomparable (keyed onto a committed file) or
   * drift its path alone proves (keyed onto nothing committed).
   */
  readonly unread?: readonly IUnreadFile[];
  readonly error?: string;
}

/**
 * Run ONE regen command into a fresh temp dir and read the result back, keyed
 * onto the committed paths it corresponds to. Always cleans up.
 *
 * `committed` is the slice this command OWNS, not the whole tree — that is what
 * keeps a multi-writer tree honest: each command's output is aligned against
 * (and later diffed against) only its own files, so writer A's output can never
 * be reported as writer B's stale committed file.
 */
function runOneRegen(
  cwd: string,
  command: string,
  committed: ReadonlyMap<string, string>,
  timeoutMs: number,
  unreadCommitted: readonly string[] = [],
): IRegenResult {
  const tmp = mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'shrk-generated-'));
  try {
    const child = spawnSync(command.split('{TMP}').join(tmp), {
      cwd,
      shell: true,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    // A spawned command may rewrite files anywhere: drop every memoised tree
    // read, so a read-cache window (`withFileReadCache`, e.g. `shrk quality`'s
    // plane section) never serves a pre-spawn snapshot after it.
    clearFileReadCache();
    if (child.error) return { error: `regen failed to start: ${child.error.message}` };
    if (child.status !== 0) {
      const tail = String(child.stderr ?? '').trim().split('\n').slice(-3).join(' | ');
      return { error: `regen exited ${child.status ?? 'null'}${tail ? ` — ${tail}` : ''}` };
    }
    const tree = readRegenTree(tmp);
    if (tree.files.size === 0 && tree.unread.length === 0) {
      return { error: 'regen wrote no files into {TMP} — the command probably ignores the output path' };
    }
    // ONE alignment for the read and the unread outputs, against the committed
    // slice AND the committed files the reader could not read, so an over-cap
    // output keys onto the same committed path a read one would.
    const keys = alignKeys(
      [...tree.files.keys(), ...tree.unread.map((u) => u.path)],
      [...committed.keys(), ...unreadCommitted],
    );
    const files = new Map<string, string>();
    for (const [p, content] of tree.files) files.set(keys.get(p) ?? p, content);
    return { files, unread: tree.unread.map((u) => ({ ...u, path: keys.get(u.path) ?? u.path })) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Every regen command a rule declares, paired with the committed slice it owns. */
interface IRegenUnit {
  readonly label: string;
  readonly command: string;
  readonly committed: ReadonlyMap<string, string>;
  readonly timeoutMs: number;
}

/**
 * The regen units for a rule: one per `sources[]` writer, or a single unit for
 * the classic `regen` form. A rule declaring neither yields none (header-only).
 */
function regenUnitsOf(rule: IGeneratedArtifactRule, scan: IGeneratedScan): IRegenUnit[] {
  const fallback = rule.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (scan.slices.length > 0) {
    return scan.slices.map((slice) => ({
      label: slice.label,
      command: slice.regen,
      committed: slice.files,
      timeoutMs: slice.timeoutMs ?? fallback,
    }));
  }
  if (rule.regen === undefined) return [];
  // Single-writer: the checkable set, so a hand-maintained bless inside the
  // glob is not compared against output no generator produces.
  return [{ label: rule.id, command: rule.regen, committed: scan.checkable, timeoutMs: fallback }];
}

/**
 * One rule's outcome. Exported so `shrk gates check` aggregates the SAME
 * evaluation the per-plane verb runs, rather than a second implementation that
 * could drift from it.
 */
export interface IGeneratedOutcome {
  readonly rule: IGeneratedArtifactRule;
  readonly status: 'passed' | 'failed' | 'skipped' | 'error';
  readonly committedCount: number;
  readonly treeDiff?: IGeneratedTreeDiff;
  readonly provenance: readonly IProvenanceFinding[];
  readonly error?: string;
  readonly skipReason?: string;
  /** True when the drift half was deliberately not run (`--headers-only` / no `regen`). */
  readonly driftChecked: boolean;
  /** Files excluded from every check by `handMaintained`. */
  readonly handMaintained: readonly string[];
  /** Per-writer drift results, for a multi-writer rule. */
  readonly writers: readonly IWriterOutcome[];
  /**
   * Set when a file in the rule's scope was not read (over the read cap): it
   * was never header-checked or byte-compared, so {@link generatedCoverage}
   * names it and the rule is never a pass.
   */
  readonly readScope?: IReadScope;
  /**
   * Set only when the rule is INTENDED-empty (round 13): every inclusion glob
   * of its `generatedGlob` is marked `expectEmpty` and no file matched. It is
   * the settle's acceptance and stands in for the rule's own coverage record
   * ({@link generatedCoverage}), so the rule passes with the acceptance printed.
   */
  readonly emptyCoverage?: IVerdictCoverage;
  /** Settle record B of the rule's `generatedGlob` — the acceptance of its intended-empty units. */
  readonly unitAcceptance?: IVerdictCoverage;
  /** The rule's dead / intended-empty / went-live `generatedGlob` units as printed lines. */
  readonly units?: IUnitStateLists;
  /** The rule's non-live `generatedGlob` units, for `--fail-on-dead-units` (`selectorUnitFails`). */
  readonly unitLiveness?: readonly IUnitLiveness[];
}

/** One writer's slice result inside a multi-writer rule. */
interface IWriterOutcome {
  readonly label: string;
  readonly committedCount: number;
  readonly differences: number;
  readonly error?: string;
}

export function evaluateGeneratedRule(
  cwd: string,
  authored: IGeneratedArtifactRule,
  excludeDirs: readonly string[],
  headersOnly: boolean,
): IGeneratedOutcome {
  // The engine entry normalises idempotently (round 13): a loaded rule comes
  // back as the SAME object; a hand-built `{ pattern, expectEmpty }` entry is a
  // glob plus a marker; a malformed entry is a misconfigured rule, never a crash.
  const normalized = normalizeRuleList(authored, 'generatedGlob');
  if (!normalized.ok) {
    return {
      rule: authored,
      status: 'error',
      committedCount: 0,
      provenance: [],
      driftChecked: false,
      handMaintained: [],
      writers: [],
      error: `generatedGlob ${normalized.error.message}`,
    };
  }
  const rule = normalized.value;
  const scan = scanGeneratedFiles(cwd, rule, excludeDirs);
  const severity = rule.severity ?? 'error';
  // A matched file the reader could not read (over the read cap) was never
  // header-checked or compared. It rides on every outcome below, so the
  // coverage names it; it is left out of the drift diff, where its absence
  // from the committed side would otherwise read as `only-regenerated`.
  const unreadScope = readScopeHasUnread(scan.readScope) ? { readScope: scan.readScope } : {};
  const unreadPaths = new Set(scan.readScope.unread.map((u) => u.path));
  // `generatedGlob` settled with its `expectEmpty` markers (round 13) — needed
  // when a unit is marked (its acceptance / went-live line rides on the
  // outcome) or when the rule matched nothing (what the empty rule is decided
  // from). An unmarked rule that matched files pays nothing extra.
  const live =
    (rule.expectEmptyUnits?.length ?? 0) > 0 || scan.generated.size === 0
      ? readGlobListLiveness(cwd, 'generatedGlob', rule.generatedGlob, rule.expectEmptyUnits ?? [], {
          subject: rule.id,
          excludeDirs: new Set(excludeDirs),
        })
      : undefined;
  const nonLive = live?.liveness.units.filter((u) => u.state !== UnitLivenessState.Live) ?? [];
  const unitFields = {
    ...(live?.liveness.acceptance !== undefined ? { unitAcceptance: live.liveness.acceptance } : {}),
    ...(live !== undefined &&
    live.liveness.dead.length + live.liveness.intendedEmpty.length + live.liveness.wentLive.length > 0
      ? { units: unitStateLists(live.liveness) }
      : {}),
    ...(nonLive.length > 0 ? { unitLiveness: nonLive } : {}),
  };

  if (scan.generated.size === 0 && unreadPaths.size > 0) {
    // Every committed file it matched is unread: not "0 files matched", so
    // PARTIAL, never failOnEmpty's failure and never a pass.
    return {
      rule,
      status: 'passed',
      committedCount: 0,
      provenance: [],
      driftChecked: false,
      handMaintained: [],
      writers: [],
      ...unreadScope,
      ...unitFields,
    };
  }

  if (scan.generated.size === 0 && live !== undefined) {
    // THE rule-emptiness settle (round 13, `settleRuleEmptiness`): every
    // inclusion glob of `generatedGlob` marked `expectEmpty` and no file
    // matched → a generated tree that does not exist yet, accepted and printed.
    // Anything else is the loud skip (failOnEmpty's 1, else 2).
    const noFiles = `0 files matched generatedGlob (${rule.generatedGlob.join(', ')})`;
    const emptiness = settleRuleEmptiness({
      subject: rule.id,
      unitLabel: 'generated files',
      filesMatched: 0,
      unitsMatched: 0,
      unread: false,
      liveness: live.liveness,
      primaryLists: ['generatedGlob'],
      failOnEmpty: failsWhenEmpty(rule),
      noFilesReason: noFiles,
      noUnitsReason: noFiles,
    });
    const empty = {
      rule,
      committedCount: 0,
      provenance: [],
      driftChecked: false,
      handMaintained: [],
      writers: [],
      ...unitFields,
    };
    if (emptiness.state === RuleEmptiness.IntendedEmpty && emptiness.coverage !== undefined) {
      return { ...empty, status: 'passed', emptyCoverage: emptiness.coverage };
    }
    return {
      ...empty,
      status: emptiness.fails ? 'failed' : 'skipped',
      skipReason: emptiness.skipReason ?? noFiles,
    };
  }

  // Headers + byte checks run over the CHECKABLE set — a hand-maintained bless
  // is excluded from both, which is the whole point of declaring it.
  const headers = checkProvenanceHeaders(rule, scan.checkable, scan.outside, {
    unclassified: scan.unclassified,
    staleHandMaintained: scan.staleHandMaintained,
  });
  if (headers.error) {
    return {
      rule,
      status: 'error',
      committedCount: scan.generated.size,
      provenance: [],
      driftChecked: false,
      handMaintained: scan.handMaintained,
      writers: [],
      error: headers.error,
      ...unreadScope,
    };
  }

  const units = headersOnly ? [] : regenUnitsOf(rule, scan);
  const differences: IGeneratedFileDiff[] = [];
  const writers: IWriterOutcome[] = [];
  const errors: string[] = [];
  // Regen outputs the reader did not read (over the regen cap) that key onto a
  // COMMITTED file: never byte-compared, so they join the rule's read scope
  // and its coverage names them. Never dropped.
  const uncomparable: IUnreadFile[] = [];
  let committedCompared = 0;
  let regeneratedCount = 0;
  for (const unit of units) {
    const regen = runOneRegen(cwd, unit.command, unit.committed, unit.timeoutMs, [...unreadPaths]);
    if (regen.error) {
      errors.push(units.length > 1 ? `${unit.label}: ${regen.error}` : regen.error);
      writers.push({ label: unit.label, committedCount: unit.committed.size, differences: 0, error: regen.error });
      continue;
    }
    const regenUnread = regen.unread ?? [];
    const keyedOnCommitted = (p: string): boolean => unit.committed.has(p) || unreadPaths.has(p);
    const unitUncomparable = regenUnread.filter((u) => keyedOnCommitted(u.path));
    uncomparable.push(...unitUncomparable);
    const skip = new Set([...unreadPaths, ...unitUncomparable.map((u) => u.path)]);
    const diff = compareGeneratedTrees(unit.committed, regen.files!, rule.compare ?? 'bytes');
    // A path whose committed or regenerated side was never read cannot be
    // compared: it is in the coverage gap, not the diff. An unread output
    // keyed onto NOTHING committed is drift its path alone proves.
    const compared: IGeneratedFileDiff[] = [
      ...diff.differences.filter((d) => !skip.has(d.file)),
      ...regenUnread
        .filter((u) => !keyedOnCommitted(u.path))
        .map((u) => ({ file: u.path, kind: 'only-regenerated' as const })),
    ];
    differences.push(...compared);
    committedCompared += diff.committedCount - unitUncomparable.filter((u) => unit.committed.has(u.path)).length;
    regeneratedCount += diff.regeneratedCount + regenUnread.length;
    writers.push({ label: unit.label, committedCount: unit.committed.size, differences: compared.length });
  }

  const ranAnyWriter = units.length > 0 && errors.length < units.length;
  const treeDiff: IGeneratedTreeDiff | undefined = ranAnyWriter
    ? { differences, committedCount: committedCompared, regeneratedCount }
    : undefined;
  const error = errors.length > 0 ? errors.join(' · ') : undefined;

  const hardFindings = headers.findings.filter((f) => f.severity === 'error');
  const drifted = differences.length > 0;
  // A writer that failed to RUN proved nothing, so the rule is in error even if
  // its siblings were clean — a partial regen must never read as a full pass.
  const status: IGeneratedOutcome['status'] =
    error !== undefined
      ? 'error'
      : drifted || (hardFindings.length > 0 && severity === 'error')
        ? 'failed'
        : 'passed';

  // The rule's read scope: the committed files the reader could not read, plus
  // each uncomparable regen output keyed onto a READ committed file (read, but
  // never compared, so it moves from examined to unexamined).
  const extra = new Map<string, IUnreadFile>();
  for (const u of uncomparable) if (!unreadPaths.has(u.path) && !extra.has(u.path)) extra.set(u.path, u);
  const finalScope: IReadScope = {
    read: scan.readScope.read - extra.size,
    unread: [...scan.readScope.unread, ...extra.values()].sort((a, b) => a.path.localeCompare(b.path)),
  };
  return {
    rule,
    status,
    committedCount: scan.generated.size,
    ...(treeDiff ? { treeDiff } : {}),
    provenance: headers.findings,
    ...(error ? { error } : {}),
    driftChecked: units.length > 0 && errors.length === 0,
    handMaintained: scan.handMaintained,
    writers: writers.length > 1 ? writers : [],
    ...(readScopeHasUnread(finalScope) ? { readScope: finalScope } : {}),
    // The acceptance of a marked planned glob and the unit lines ride on a
    // connected rule too (round 13), not only on an empty one.
    ...unitFields,
  };
}

/**
 * What one generated-artifact rule examined — shared by `generated check` and
 * the aggregate (`gates check`, `quality`), so both report the same scope.
 *
 * `driftSkipped` is the aggregate's `--no-spawn` case: headers and
 * classification ran, the regen diff did not, so no file's CONTENTS were
 * verified. (`generated check --headers-only` is a narrowing the caller asked
 * for, not a gap.)
 */
export function generatedCoverage(o: IGeneratedOutcome, driftSkipped = false): IVerdictCoverage {
  // An intended-empty rule (round 13: every `generatedGlob` inclusion glob
  // marked `expectEmpty`, no file matched) is covered by its acceptance — the
  // settle's own record, printed at exit 0.
  if (o.emptyCoverage !== undefined) return o.emptyCoverage;
  // A file in scope the reader could not read folds in through the one rule
  // every plane uses (`readScopeCoverage`): `examined N of M files`, named.
  return readScopeCoverage(planeGeneratedCoverage(o, driftSkipped), o.readScope);
}

function planeGeneratedCoverage(o: IGeneratedOutcome, driftSkipped: boolean): IVerdictCoverage {
  if (o.skipReason !== undefined) {
    return { unit: 'generated files', expected: 0, examined: 0, reason: o.skipReason };
  }
  if (o.status === 'error') {
    return {
      unit: 'generated files',
      expected: o.committedCount,
      examined: 0,
      reason: 'the rule could not be evaluated',
    };
  }
  if (driftSkipped) {
    return {
      unit: 'generated files',
      expected: o.committedCount,
      examined: 0,
      reason: 'regen drift check skipped by --no-spawn',
    };
  }
  return { unit: 'generated files', expected: o.committedCount, examined: o.committedCount };
}

export function generatedHintFor(rule: IGeneratedArtifactRule): string {
  return (
    rule.hint ??
    (rule.regen || rule.sources
      ? `regenerate with \`shrk generated update --id ${rule.id}\` and commit the result`
      : 'add the provenance header to the generated file, or move it out of the generated glob')
  );
}

function outcomeJson(o: IGeneratedOutcome): Record<string, unknown> {
  return {
    id: o.rule.id,
    ...(o.rule.description ? { description: o.rule.description } : {}),
    status: o.status,
    severity: o.rule.severity ?? 'error',
    committedCount: o.committedCount,
    driftChecked: o.driftChecked,
    handMaintained: o.handMaintained,
    ...(o.writers.length > 0 ? { writers: o.writers } : {}),
    ...(o.treeDiff ? { differences: o.treeDiff.differences, regeneratedCount: o.treeDiff.regeneratedCount } : {}),
    provenance: o.provenance,
    ...(o.error ? { error: o.error } : {}),
    ...(o.skipReason ? { skipReason: o.skipReason } : {}),
    hint: generatedHintFor(o.rule),
  };
}

async function prepare(
  args: ParsedArgs,
  /** `rejectedKnown`: a verdict verb may select a rejected rule by `--id` (its errored row). */
  opts: { readonly rejectedKnown?: boolean } = {},
): Promise<
  | {
      ok: true;
      cwd: string;
      rules: readonly IGeneratedArtifactRule[];
      all: readonly IGeneratedArtifactRule[];
      excludeDirs: string[];
      planeDiagnostics: readonly string[];
      /** Merge-seam-rejected pack rules, narrowed by `--id` (round 12 review, R12-X1). */
      rejected: readonly IGateRuleResult[];
    }
  | { ok: false; code: number }
> {
  const cwd = resolveCwd(args);
  const json = flagBool(args, 'json');
  const loaded = await loadRules(cwd);
  if (!loaded.ok) {
    if (json) process.stdout.write(asJson({ schema: SCHEMA, error: loaded.message }) + '\n');
    else process.stderr.write(`Could not load config: ${loaded.message}\n  Run \`shrk doctor\` for details.\n`);
    return { ok: false, code: ExitCode.UsageError };
  }
  const id = flagString(args, 'id');
  let rules = loaded.value.rules;
  let rejected = loaded.value.rejected;
  if (id) {
    const wanted = id.split(',').map((s) => s.trim()).filter(Boolean);
    const known = new Set([
      ...rules.map((r) => r.id),
      ...(opts.rejectedKnown === true ? rejected.map((r) => r.id) : []),
    ]);
    const unknown = wanted.filter((w) => !known.has(w));
    if (unknown.length > 0) {
      process.stderr.write(
        `Unknown generated-artifact id(s): ${unknown.join(', ')}. Declared: ${[...known].join(', ') || '(none)'}\n`,
      );
      return { ok: false, code: ExitCode.UsageError };
    }
    rules = rules.filter((r) => wanted.includes(r.id));
    rejected = rejected.filter((r) => wanted.includes(r.id));
  }
  return {
    ok: true,
    cwd,
    rules,
    all: loaded.value.rules,
    excludeDirs: loaded.value.excludeDirs,
    planeDiagnostics: loaded.value.planeDiagnostics,
    rejected,
  };
}

/**
 * The "no rules declared" landing. A VERDICT verb passes its name so its JSON
 * still carries the settled `gate` envelope — nothing declared is `2`.
 */
function writeNoRules(json: boolean, verb?: string): number {
  // A VERDICT verb settles first and renders second, in text AND JSON: nothing
  // declared proposes 0 and the run coverage (expected 0) settles it to 2. The
  // exit comes from the envelope — never a hard-coded code — so text, JSON and
  // gate.exit cannot disagree. List / explain subverbs stay informational.
  const gate =
    verb !== undefined
      ? buildGateEnvelope(verb, ExitCode.VerifiedPass, [], {
          unit: 'generated-artifact rules',
          expected: 0,
          examined: 0,
          reason: 'no generatedArtifacts[] declared',
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
  process.stdout.write(header('Generated artifacts'));
  process.stdout.write(
    '  No generated-artifact rules declared. Add `generatedArtifacts[]` to\n' +
      '  sharkcraft.config.ts to catch hand-edited generated files and missing\n' +
      '  "do not edit" headers (see docs/generated-drift.md).\n',
  );
  if (gate) {
    const line = verdictLine(gate, 'Nothing declared — accepted.');
    if (line) process.stdout.write(`\n${line}\n`);
  }
  return exit;
}

export const generatedListCommand: ICommandHandler = {
  name: 'list',
  description: 'List every declared generated-artifact rule: its globs, regen command, and header contract.',
  usage: 'shrk generated list [--json]',
  booleanFlags: new Set(['json']),
  async run(args: ParsedArgs): Promise<number> {
    const prep = await prepare(args);
    if (!prep.ok) return prep.code;
    const json = flagBool(args, 'json');
    if (prep.all.length === 0 && prep.rejected.length === 0) return writeNoRules(json);
    if (json) {
      process.stdout.write(
        asJson({
          schema: SCHEMA,
          // Declared by a pack, refused by the merge seam: never checked.
          rejected: prep.rejected.map((r) => ({ id: r.id, error: r.error ?? null })),
          rules: prep.all.map((r) => ({
            id: r.id,
            description: r.description ?? null,
            generatedGlob: r.generatedGlob,
            regen: r.regen ?? null,
            sources: r.sources ?? null,
            handMaintained: r.handMaintained ?? null,
            handMaintainedMarker: r.handMaintainedMarker ?? null,
            compare: r.compare ?? 'bytes',
            provenanceHeader: r.provenanceHeader ?? null,
            // The EFFECTIVE failOnEmpty (round 13) — THE authority, never the
            // raw field: an error rule fails on empty by default.
            failOnEmpty: failsWhenEmpty(r),
          })),
          diagnostics: prep.planeDiagnostics,
        }) + '\n',
      );
      return ExitCode.VerifiedPass;
    }
    process.stdout.write(header(`Generated artifacts (${prep.all.length})`));
    for (const r of prep.all) {
      process.stdout.write(`  • ${r.id}\n`);
      process.stdout.write(`      glob   ${r.generatedGlob.join(', ')}\n`);
      if (r.sources && r.sources.length > 0) {
        process.stdout.write(`      regen  ${r.sources.length} writer(s):\n`);
        r.sources.forEach((src, i) => {
          process.stdout.write(`               [${src.id ?? i}] ${src.regen}\n`);
          process.stdout.write(`                    owns ${src.glob.join(', ')}\n`);
        });
      } else {
        process.stdout.write(`      regen  ${r.regen ?? '(header-only — never spawns)'}\n`);
      }
      if (r.handMaintained && r.handMaintained.length > 0) {
        process.stdout.write(`      hand   ${r.handMaintained.join(', ')}  (exempt from header + byte checks)\n`);
      }
      if (r.handMaintainedMarker) {
        process.stdout.write(`      marker /${r.handMaintainedMarker}/  (in-file bless)\n`);
      }
      if (r.provenanceHeader) {
        process.stdout.write(
          `      header /${r.provenanceHeader.mustMatch}/${r.provenanceHeader.forbidOutside ? '  + mislabel check' : ''}\n`,
        );
      }
      if (r.description) process.stdout.write(`      ${r.description}\n`);
    }
    if (prep.rejected.length > 0) {
      process.stdout.write(`\n  rejected at the pack-plane merge seam — never checked (${prep.rejected.length}):\n`);
      writeRejected(prep.rejected);
    }
    for (const d of prep.planeDiagnostics) process.stdout.write(`  ! ${d}\n`);
    return ExitCode.VerifiedPass;
  },
};

export const generatedCheckCommand: ICommandHandler = {
  name: 'check',
  description:
    'Regenerate into a temp dir and diff BOTH ways (hand-edited file AND regen-writes-a-subset), plus the "do not edit" header contract.',
  usage: 'shrk generated check [--id <ids>] [--headers-only] [--json]',
  booleanFlags: new Set(['json', 'headers-only']),
  async run(args: ParsedArgs): Promise<number> {
    const prep = await prepare(args, { rejectedKnown: true });
    if (!prep.ok) return prep.code;
    const json = flagBool(args, 'json');
    const headersOnly = flagBool(args, 'headers-only');
    // A pack rule the merge seam rejected is a declared rule that was never
    // checked — an errored row, exit 1 (round 12 review, R12-X1).
    const rejected = prep.rejected;
    if (prep.rules.length === 0 && rejected.length === 0) return writeNoRules(json, 'generated check');

    const outcomes = prep.rules.map((r) => evaluateGeneratedRule(prep.cwd, r, prep.excludeDirs, headersOnly));
    const failed = outcomes.filter(
      (o) => o.status === 'failed' || (o.status === 'error' && (o.rule.severity ?? 'error') === 'error'),
    );
    const evaluated = outcomes.filter((o) => o.status !== 'skipped').length;
    const skippedCount = outcomes.length - evaluated;
    const proposed =
      failed.length > 0 || rejected.length > 0
        ? ExitCode.Failure
        : evaluated === 0 || skippedCount > 0
          ? ExitCode.NotVerified
          : ExitCode.VerifiedPass;
    // Settle first, render second: one envelope for text AND JSON, and the ✓
    // line is printed only from the settled verdict. `--headers-only` is a
    // narrowing the caller asked for, so it is not a coverage gap here.
    const unexamined = [
      ...outcomes.filter((o) => o.status === 'skipped' || o.status === 'error').map((o) => o.rule.id),
      ...rejected.map((r) => r.id),
    ];
    const env = buildGateEnvelope(
      'generated check',
      proposed,
      [...outcomes.map((o) => ({
        id: o.rule.id,
        type: 'generated' as const,
        status: o.status,
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
        ...(o.skipReason ? { skipReason: o.skipReason } : {}),
        ...(o.error ? { error: o.error } : {}),
        coverage: generatedCoverage(o),
        // The rule's `expectEmpty` acceptance and unit lines (round 13), folded
        // into the envelope's one settle.
        ...(o.unitAcceptance !== undefined ? { unitAcceptance: o.unitAcceptance } : {}),
        ...(o.units !== undefined ? { units: o.units } : {}),
      })), ...rejected],
      {
        unit: 'generated-artifact rules',
        expected: outcomes.length + rejected.length,
        examined: outcomes.length + rejected.length - unexamined.length,
        ...(unexamined.length > 0 ? { unexamined, reason: 'checked nothing or could not run' } : {}),
      },
    );
    const exit = env.exit;

    if (json) {
      process.stdout.write(
        asJson({
          schema: SCHEMA,
          headersOnly,
          results: outcomes.map(outcomeJson),
          // Pack rules the merge seam refused — errored rows in `gate.rules`.
          rejected: rejected.map((r) => ({ id: r.id, error: r.error ?? null })),
          evaluated,
          skipped: outcomes.filter((o) => o.status === 'skipped').length,
          verdict: exit === ExitCode.Failure ? 'errors' : exit === ExitCode.VerifiedPass ? 'pass' : 'not-verified',
          diagnostics: prep.planeDiagnostics,
          exitCode: exit,
          gate: env,
        }) + '\n',
      );
      return exit;
    }

    process.stdout.write(header('Generated-artifact drift'));
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
    if (headersOnly) process.stdout.write(kv('scope', 'headers only — no regen was run') + '\n');
    for (const o of outcomes) {
      if (o.status === 'skipped') {
        process.stdout.write(`  – ${o.rule.id}  SKIPPED — ${o.skipReason}\n`);
        continue;
      }
      if (o.status === 'error') {
        process.stdout.write(`  ! ${o.rule.id}  ${o.error}\n`);
        continue;
      }
      // A rule that matched nothing and FAILS on it (failOnEmpty) produced no
      // diff and no regen output — its skip reason is the only true line. It is
      // never rendered as drift with a bless hint (round 13).
      if (o.status === 'failed' && o.skipReason !== undefined) {
        process.stdout.write(`  ✗ ${o.rule.id}  FAILED — ${o.skipReason}\n`);
        process.stdout.write(`      → ${formatEmptyRuleAdvice({ fails: true })}\n`);
        continue;
      }
      const diffs = o.treeDiff?.differences ?? [];
      // Rendered from the SETTLED rule: a pass over part of its scope is
      // `partial`, never a ✓ (the keystone emitter pattern, step 5).
      const settledRule = env.rules.find((x) => x.id === o.rule.id);
      if (o.status === 'passed' && settledRule?.status === 'partial') {
        process.stdout.write(
          `  ~ ${o.rule.id}  PARTIAL — ${settledRule.shortfall ?? 'part of its scope was not examined'}\n`,
        );
      } else if (o.status === 'passed') {
        const exempt = o.handMaintained.length > 0 ? `, ${o.handMaintained.length} hand-maintained` : '';
        process.stdout.write(
          `  ✓ ${o.rule.id}  (${o.committedCount} files${exempt}` +
            `${o.driftChecked ? ', byte-identical to a fresh regen' : ', headers only'})\n`,
        );
        for (const w of o.writers) {
          process.stdout.write(`      · ${w.label}: ${w.committedCount} file(s) verified\n`);
        }
      } else {
        process.stdout.write(`  ✗ ${o.rule.id}  ${diffs.length} file(s) differ from a fresh regen\n`);
        for (const w of o.writers) {
          process.stdout.write(
            `      · ${w.label}: ${w.error ? `ERROR — ${w.error}` : `${w.differences} of ${w.committedCount} differ`}\n`,
          );
        }
        for (const d of diffs.slice(0, 25)) {
          const label =
            d.kind === 'content'
              ? 'hand-edited (or source changed)'
              : d.kind === 'only-committed'
                ? 'committed but regen no longer produces it'
                : 'regen produces it but it is not committed';
          process.stdout.write(`      • ${d.file}  — ${label}\n`);
        }
        if (diffs.length > 25) process.stdout.write(`      … (${diffs.length - 25} more)\n`);
      }
      for (const f of o.provenance.slice(0, 25)) {
        process.stdout.write(`      [${f.severity}] ${f.file} — ${f.message}\n`);
      }
      if (o.provenance.length > 25) {
        process.stdout.write(`      … (${o.provenance.length - 25} more header finding(s))\n`);
      }
      if (o.status === 'failed') process.stdout.write(`      → ${generatedHintFor(o.rule)}\n`);
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
    // THE shared unit-state block (round 13, K2): a dead `generatedGlob` of a
    // rule that still matched, and a LOCAL expectEmpty marker whose target
    // appeared, withhold the ✓ (exit unchanged); a pack marker is INFO.
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
      qualifyCleanForUnits('Every generated artifact matches its source. ✓', unitNotes),
      proposed === ExitCode.NotVerified && evaluated === 0
        ? 'Nothing was checked — this is NOT a pass. Every rule matched 0 files.'
        : undefined,
    );
    if (line) process.stdout.write(`\n${line}\n`);
    return exit;
  },
};

/** What `generated update` did for one regen unit. */
interface IUpdateResult {
  readonly id: string;
  readonly ran: boolean;
  readonly error?: string;
  /** Committed files whose content the regen changed — rewritten in place. */
  readonly written: readonly string[];
  readonly unchanged: readonly string[];
  /** New files the regen produced, placed inside the rule's generatedGlob. */
  readonly created: readonly string[];
  /** Regen output that maps to no committed path and cannot be placed inside the glob. */
  readonly notPlaced: readonly string[];
  /** Committed files the regen no longer produces — reported, NEVER deleted. */
  readonly noLongerProduced: readonly string[];
  /**
   * Regen outputs the reader did not read (over the regen cap): NOT written,
   * so the bless is incomplete and the run says so (exit 1), never silently.
   */
  readonly unreadOutputs?: readonly string[];
}

const EMPTY_WRITES = { written: [], unchanged: [], created: [], notPlaced: [], noLongerProduced: [] } as const;

/** The leading literal directory of a glob (`docs/schemas/*.json` → `docs/schemas`). */
function globStaticDir(glob: string): string | undefined {
  const out: string[] = [];
  for (const seg of glob.split('/').slice(0, -1)) {
    if (/[*?[\]{}]/.test(seg)) break;
    out.push(seg);
  }
  return out.length > 0 ? out.join('/') : undefined;
}

/**
 * Where a regen unit's NEW files belong: the single directory its committed
 * slice lives in, or — for a first generation with nothing committed yet — the
 * single literal directory its INCLUSION globs name. Ambiguous → undefined,
 * and the new file is reported instead of guessed.
 *
 * Only an inclusion glob says where files live: a negation
 * (`!gen/**\/*.hand.ts`) names what is carved OUT, and read raw its leading
 * `!gen` was a second "directory" that made every first generation ambiguous.
 */
function sliceTargetDir(
  committed: ReadonlyMap<string, string>,
  globs: readonly string[],
): string | undefined {
  const dirs = new Set([...committed.keys()].map((p) => nodePath.posix.dirname(p)));
  if (dirs.size === 1) return [...dirs][0];
  if (dirs.size > 1) return undefined;
  const statics = new Set(
    globListWalkGlobs(globs)
      .map(globStaticDir)
      .filter((d): d is string => d !== undefined),
  );
  return statics.size === 1 ? [...statics][0] : undefined;
}

function writeOut(cwd: string, rel: string, content: string): void {
  const abs = nodePath.join(cwd, rel);
  mkdirSync(nodePath.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

/**
 * Write a regen unit's ALIGNED output over the committed tree.
 *
 * The keys come from {@link runOneRegen} — the same alignment `generated check`
 * diffs against — so "which committed file does this output replace" has one
 * answer for both verbs. Output that aligns to nothing is a new file: it is
 * written only where the rule's own glob says generated files live, never at a
 * bare temp-relative path (which is how a flat regen used to land at the repo
 * root). A committed file the regen stopped producing is reported, not
 * deleted: removing tracked files is a decision for a human.
 */
function writeAligned(
  cwd: string,
  rule: IGeneratedArtifactRule,
  scan: IGeneratedScan,
  committed: ReadonlyMap<string, string>,
  files: ReadonlyMap<string, string>,
): Omit<IUpdateResult, 'id' | 'ran' | 'error'> {
  const written: string[] = [];
  const unchanged: string[] = [];
  const created: string[] = [];
  const notPlaced: string[] = [];
  const blessed = new Set(scan.handMaintained);
  const targetDir = sliceTargetDir(committed, rule.generatedGlob);
  for (const [key, content] of files) {
    if (committed.has(key)) {
      if (committed.get(key) === content) unchanged.push(key);
      else {
        writeOut(cwd, key, content);
        written.push(key);
      }
      continue;
    }
    const candidates = [key, ...(targetDir ? [nodePath.posix.join(targetDir, key)] : [])];
    // A new output is placed only where `generatedGlob` SELECTS it — never on
    // a path the list excludes, which the next check would not cover.
    const dest = candidates.find((c) => globListSelects(c, rule.generatedGlob) && !blessed.has(c));
    if (!dest) {
      notPlaced.push(key);
      continue;
    }
    writeOut(cwd, dest, content);
    created.push(dest);
  }
  const produced = new Set([...written, ...unchanged]);
  const noLongerProduced = [...committed.keys()].filter((p) => !produced.has(p)).sort();
  return {
    written: written.sort(),
    unchanged: unchanged.sort(),
    created: created.sort(),
    notPlaced: notPlaced.sort(),
    noLongerProduced,
  };
}

export const generatedUpdateCommand: ICommandHandler = {
  name: 'update',
  description:
    'The bless step after an intentional source change: regenerate into a temp dir with the SAME regen + path alignment `generated check` uses, then write the aligned files over their committed paths. Writes files; never deletes a committed file.',
  usage: 'shrk generated update [--id <ids>] [--json]',
  booleanFlags: new Set(['json']),
  async run(args: ParsedArgs): Promise<number> {
    const prep = await prepare(args);
    if (!prep.ok) return prep.code;
    const json = flagBool(args, 'json');
    if (prep.rules.length === 0) return writeNoRules(json);

    const results: IUpdateResult[] = [];
    for (const rule of prep.rules) {
      // `{TMP}` means the same thing here as in `check`. Update used to
      // substitute the project root instead, so a flat regen such as
      // `schemas emit --out {TMP}` wrote every file at the repo ROOT while
      // `check` compared against docs/schemas/ — two answers to "where does
      // the output land". Regenerating through runOneRegen makes it one.
      // A multi-writer rule blesses EVERY writer's slice, never just one.
      const scan = scanGeneratedFiles(prep.cwd, rule, prep.excludeDirs);
      const units = regenUnitsOf(rule, scan);
      if (units.length === 0) {
        results.push({ id: rule.id, ran: false, error: 'header-only rule — nothing to regenerate', ...EMPTY_WRITES });
        continue;
      }
      for (const unit of units) {
        const regen = runOneRegen(prep.cwd, unit.command, unit.committed, unit.timeoutMs);
        if (regen.error || !regen.files) {
          results.push({ id: unit.label, ran: true, error: regen.error ?? 'regen produced no files', ...EMPTY_WRITES });
          continue;
        }
        // An output the reader did not read (over the regen cap) is never
        // written: it is listed, and the bless is reported incomplete (1).
        // Its committed counterpart is not "no longer produced".
        const unreadKeys = new Set((regen.unread ?? []).map((u) => u.path));
        const aligned = writeAligned(prep.cwd, rule, scan, unit.committed, regen.files);
        results.push({
          id: unit.label,
          ran: true,
          ...aligned,
          noLongerProduced: aligned.noLongerProduced.filter((p) => !unreadKeys.has(p)),
          ...(unreadKeys.size > 0 ? { unreadOutputs: [...unreadKeys].sort() } : {}),
        });
      }
    }
    const failed = results.filter((r) => r.error !== undefined);
    // The bless is incomplete when output could not be placed, a committed
    // file is no longer produced, or an output was too large to read:
    // `generated check` would still fail, so exiting 0 here would claim a sync
    // that did not happen.
    const outOfSync = results.filter(
      (r) => r.notPlaced.length > 0 || r.noLongerProduced.length > 0 || (r.unreadOutputs?.length ?? 0) > 0,
    );
    const exit = failed.length > 0 || outOfSync.length > 0 ? ExitCode.Failure : ExitCode.VerifiedPass;
    if (json) {
      process.stdout.write(
        asJson({ schema: SCHEMA, inSync: failed.length === 0 && outOfSync.length === 0, results, exitCode: exit }) + '\n',
      );
      return exit;
    }
    process.stdout.write(header('Generated update'));
    for (const r of results) {
      if (r.error) {
        process.stdout.write(`  ! ${r.id} — ${r.error}\n`);
        continue;
      }
      process.stdout.write(
        `  ✓ ${r.id}  — ${r.written.length} rewritten, ${r.created.length} new, ${r.unchanged.length} unchanged\n`,
      );
      for (const f of r.written) process.stdout.write(`      ~ ${f}\n`);
      for (const f of r.created) process.stdout.write(`      + ${f}\n`);
      for (const f of r.notPlaced) {
        process.stdout.write(`      ! not written: ${f} — maps to no committed file and lies outside generatedGlob\n`);
      }
      for (const f of r.unreadOutputs ?? []) {
        process.stdout.write(`      ! not written: ${f} — over the regen read cap, so it was never read\n`);
      }
      for (const f of r.noLongerProduced) {
        process.stdout.write(`      ? no longer produced (left in place — delete it if that is intended): ${f}\n`);
      }
    }
    process.stdout.write(
      exit === ExitCode.VerifiedPass
        ? '\nRegenerated. Review `git diff` before committing.\n'
        : '\nNot fully blessed — `generated check` will still report the files above.\n',
    );
    return exit;
  },
};

export const generatedExplainCommand: ICommandHandler = {
  name: 'explain',
  description:
    'Show what ONE generated-artifact rule sees right now: files matched, header contract results, mislabel candidates — without running the regen.',
  usage: 'shrk generated explain --id <id> [--json]',
  booleanFlags: new Set(['json']),
  async run(args: ParsedArgs): Promise<number> {
    const id = flagString(args, 'id') ?? args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk generated explain --id <id>\n');
      return ExitCode.UsageError;
    }
    const prep = await prepare(args);
    if (!prep.ok) return prep.code;
    const rule = prep.all.find((r) => r.id === id);
    if (!rule) {
      process.stderr.write(
        `No generated-artifact rule "${id}". Declared: ${prep.all.map((r) => r.id).join(', ') || '(none)'}\n`,
      );
      return ExitCode.UsageError;
    }
    // explain never spawns — the point is to show what the rule SEES.
    const scan = scanGeneratedFiles(prep.cwd, rule, prep.excludeDirs);
    const outcome = evaluateGeneratedRule(prep.cwd, rule, prep.excludeDirs, true);
    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({
          schema: 'sharkcraft.generated-explain/v1',
          ...outcomeJson(outcome),
          files: [...scan.generated.keys()],
          checkable: [...scan.checkable.keys()],
          handMaintained: scan.handMaintained,
          markedHandMaintained: scan.markedHandMaintained,
          staleHandMaintained: scan.staleHandMaintained,
          unclassified: scan.unclassified,
          slices: scan.slices.map((sl) => ({
            label: sl.label,
            regen: sl.regen,
            glob: sl.glob,
            files: [...sl.files.keys()],
          })),
          outsideScanned: scan.outside.size,
          outsideGlobs: scan.outsideGlobs,
          regen: rule.regen ?? null,
        }) + '\n',
      );
      return ExitCode.VerifiedPass;
    }
    process.stdout.write(header(`Generated artifact: ${rule.id}`));
    if (rule.description) process.stdout.write(`  ${rule.description}\n`);
    process.stdout.write(kv('glob', rule.generatedGlob.join(', ')) + '\n');
    process.stdout.write(kv('files matched', String(scan.generated.size)) + '\n');
    if (scan.slices.length > 0) {
      process.stdout.write(kv('writers', String(scan.slices.length)) + '\n');
      for (const sl of scan.slices) {
        process.stdout.write(`      [${sl.label}] ${sl.files.size} file(s) — ${sl.regen}\n`);
        process.stdout.write(`            owns ${sl.glob.join(', ')}\n`);
      }
    } else {
      process.stdout.write(kv('regen', rule.regen ?? '(header-only)') + '\n');
    }
    if (scan.handMaintained.length > 0) {
      process.stdout.write(
        kv('hand-maintained', `${scan.handMaintained.length} file(s) — exempt from header + byte checks`) + '\n',
      );
      const marked = new Set(scan.markedHandMaintained);
      // Say WHICH mechanism blessed each file: a config entry and an in-file
      // marker are reviewed in different places, so "why is this exempt?" has
      // two different answers and the reader needs to know which one applies.
      for (const f of scan.handMaintained.slice(0, 20)) {
        process.stdout.write(`      ${f}${marked.has(f) ? '  (in-file marker)' : '  (handMaintained[])'}\n`);
      }
    }
    if (scan.unclassified.length > 0) {
      process.stdout.write(
        kv('unclassified', `${scan.unclassified.length} file(s) — owned by no writer, not blessed`) + '\n',
      );
      for (const f of scan.unclassified.slice(0, 20)) process.stdout.write(`      ${f}\n`);
    }
    for (const pattern of scan.staleHandMaintained) {
      process.stdout.write(`  ! handMaintained "${pattern}" matches no file — stale bless\n`);
    }
    process.stdout.write(kv('compare', rule.compare ?? 'bytes') + '\n');
    if (rule.provenanceHeader) {
      process.stdout.write(kv('header', `/${rule.provenanceHeader.mustMatch}/`) + '\n');
      if (rule.provenanceHeader.forbidOutside) {
        process.stdout.write(
          kv('mislabel scan', `${scan.outside.size} file(s) via ${scan.outsideGlobs.join(', ')}`) + '\n',
        );
      }
    }
    process.stdout.write(kv('header findings', String(outcome.provenance.length)) + '\n');
    for (const f of outcome.provenance.slice(0, 50)) {
      process.stdout.write(`  [${f.kind}] ${f.file} — ${f.message}\n`);
    }
    if (scan.generated.size > 0) {
      process.stdout.write('\n  files:\n');
      for (const f of [...scan.generated.keys()].slice(0, 50)) process.stdout.write(`    ${f}\n`);
      if (scan.generated.size > 50) process.stdout.write(`    … (${scan.generated.size - 50} more)\n`);
    }
    process.stdout.write(
      `\n  Run \`shrk generated check --id ${rule.id}\` to regenerate into a temp dir and diff.\n`,
    );
    return ExitCode.VerifiedPass;
  },
};

