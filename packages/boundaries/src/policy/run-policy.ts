import * as nodePath from 'node:path';
import {
  normalizeRuleList,
  settleUnitLiveness,
  unitStateLists,
  UnitLivenessState,
  type IPolicyRule,
  type PolicySurface,
} from '@shrkcrft/core';
import { globListSelects } from '../scan/glob.ts';
import type { IReadScope } from '../util/read-scope.ts';
import { readScopeHasUnread, readScopeOf, unreadEntryWhollyMatches } from '../util/read-scope-coverage.ts';
import { readMatchingFiles } from '../util/walk-files.ts';
import { globListUnits } from '../util/dead-glob-units.ts';
import { globListLivenessInput } from '../util/glob-list-liveness-input.ts';
import { allExcludedCause } from '../util/negation-cause.ts';
import { extractInlineTemplates } from './extract-templates.ts';
import { evaluatePolicy, type IPolicyReport, type IPolicyUnit } from './evaluate-policy.ts';
import type { IPolicyRuleLiveness } from './i-policy-rule-liveness.ts';

/** Per-surface default globs when a rule omits `files`. */
const SURFACE_DEFAULT_GLOBS: Record<PolicySurface, readonly string[]> = {
  // markup files (scanned whole) + source files (inline `template:` extracted).
  template: ['**/*.html', '**/*.htm', '**/*.ts', '**/*.tsx'],
  style: ['**/*.css', '**/*.scss', '**/*.sass', '**/*.less', '**/*.styl'],
  ts: ['**/*.ts', '**/*.tsx'],
};

const SOURCE_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

export interface IRunPolicyOptions {
  /** Restrict to rules on these surfaces. */
  readonly surfaces?: readonly PolicySurface[];
  /** Run only these rule ids. */
  readonly only?: readonly string[];
  /** When true, only run rules whose globs match a changed file. */
  readonly changedOnly?: boolean;
  readonly changedFiles?: readonly string[];
  /** Project-relative directories to prune from the walk (e.g. the SharkCraft asset dir). */
  readonly excludeDirs?: readonly string[];
}

function globsFor(rule: IPolicyRule): readonly string[] {
  return rule.files && rule.files.length > 0 ? rule.files : SURFACE_DEFAULT_GLOBS[rule.surface];
}

// Why a rule scanned nothing when its OWN negations emptied its `files[]` is
// THE shared cause (`allExcludedCause`, util/negation-cause.ts — the wiring
// engine words its source side from the same module). The coverage reason
// carries it bare (the shortfall line already says "0 content units"); the
// skip reason leads with the count. `evaluatePolicy` words both.

/** The report of a run with no rule in scope. */
function emptyReport(): IPolicyReport {
  return {
    schema: 'sharkcraft.policy-lint/v1',
    rules: [],
    findings: [],
    diagnostics: [],
    suppressed: [],
    skipped: [],
    evaluated: 0,
    acceptedEmpty: 0,
    verdict: 'pass',
  };
}

/**
 * Filesystem-backed policy-lint. Walks the project once; on the `template`
 * surface, source files contribute their inline `template:` bodies (with real
 * source line numbers) while `.html` files are scanned whole. Pure-engine
 * output; the only IO is the read-only walk + reads.
 */
export function runPolicyLint(
  projectRoot: string,
  rules: readonly IPolicyRule[],
  options: IRunPolicyOptions = {},
): IPolicyReport {
  // The engine entry normalises idempotently (round 13): a loaded rule comes
  // back as the SAME object (so every per-rule memo below hits), a hand-built
  // `{ pattern, expectEmpty }` entry becomes a unit plus a marker. A MALFORMED
  // entry is left for `evaluatePolicy` to report as a misconfigured rule, and
  // no glob reader below is ever handed it.
  const malformed = new Set<IPolicyRule>();
  let selected = rules.map((r) => {
    const n = normalizeRuleList(r, 'files');
    if (n.ok) return n.value;
    malformed.add(r);
    return r;
  });
  if (options.surfaces && options.surfaces.length > 0) {
    const s = new Set(options.surfaces);
    selected = selected.filter((r) => s.has(r.surface));
  }
  if (options.only && options.only.length > 0) {
    const ids = new Set(options.only);
    selected = selected.filter((r) => ids.has(r.id));
  }
  if (options.changedOnly) {
    const changed = options.changedFiles ?? [];
    // A changed file the rule's own `files` EXCLUDE (a `!` entry) cannot put a
    // finding in its scope, so it does not select the rule. A malformed rule
    // has no footprint to prove it out of scope, so it stays in (and errors).
    selected = selected.filter((r) => malformed.has(r) || changed.some((c) => globListSelects(c, globsFor(r))));
  }
  if (selected.length === 0) return emptyReport();

  // Under --changed-only, restrict the SCANNED files to the changed set too (not
  // just rule selection). Per-file regex findings have no cross-file dependency,
  // so a pre-existing violation in a file the diff never touched is out of scope
  // — this mirrors how `check boundaries`/wiring restrict to the changeset and
  // stops the gate failing RED on untouched legacy debt.
  const changedSet = options.changedOnly ? new Set(options.changedFiles ?? []) : undefined;
  const excludeDirs = new Set(options.excludeDirs ?? []);
  // One POSITIVE walk over the union; each rule selects its own units from it
  // (`globListSelects`), so rule A's `!x` never removes x from rule B.
  const allGlobs = [...new Set(selected.filter((r) => !malformed.has(r)).flatMap((r) => [...globsFor(r)]))];
  const matched = readMatchingFiles(projectRoot, allGlobs, excludeDirs);
  const cache = matched.files;
  // The walk holds every file any selected rule's inclusion globs matched —
  // the positive set — so a glob absent from it matched nothing.
  const walked = [...cache.keys()];

  const unitsByRule = new Map<IPolicyRule, readonly IPolicyUnit[]>();
  const unitsFor = (rule: IPolicyRule): readonly IPolicyUnit[] => {
    const memo = unitsByRule.get(rule);
    if (memo !== undefined) return memo;
    const units = resolveUnits(rule);
    unitsByRule.set(rule, units);
    return units;
  };
  // What each rule's walk covered: the matched files in its scope (the
  // changeset, under --changed-only) that were read, and the ones the reader
  // reported UNREAD (over the read cap, or unreadable). The reader's own list
  // is the one answer to "was this matched path left unexamined?". Nothing
  // here re-derives the walk's skip rules or re-stats a path: a path the walk
  // never reaches is neither read nor unread, which is exactly narrowing.
  const scopeByRule = new Map<IPolicyRule, IReadScope>();
  const scopeFor = (rule: IPolicyRule): IReadScope => {
    const memo = scopeByRule.get(rule);
    if (memo !== undefined) return memo;
    const raw = readScopeOf(matched, globsFor(rule), changedSet);
    // An `exemptFiles` file's hits can only ever be suppressions, so leaving
    // it unread cannot change the verdict: an explicit exemption is narrowing,
    // not a gap (the keystone contract). Without this, a large exempted
    // vendored or generated file made the rule NOT VERIFIED (2) for good, with
    // no valve (`--allow-empty` never accepts a partial scope).
    const exempt = rule.exemptFiles && rule.exemptFiles.length > 0 ? rule.exemptFiles : undefined;
    const scope: IReadScope =
      exempt === undefined
        ? raw
        : { read: raw.read, unread: raw.unread.filter((u) => !unreadEntryWhollyMatches(u, exempt)) };
    scopeByRule.set(rule, scope);
    return scope;
  };
  // Per-glob units of the author's OWN `files[]`, off the walk this run already
  // did, settled with the rule's `expectEmpty` markers (round 13): core's one
  // authority, `settleUnitLiveness`, over THE gate-plane glob predicate
  // (`globListLivenessInput`) — the same input `gates coverage` builds, so the
  // two cannot disagree about one glob. The one dead-unit decision
  // (`globListUnits`) judges a negation by what it EXCLUDES, and a glob that
  // reaches an UNREAD file (or beneath an unlistable directory) the list keeps
  // in scope is never dead. A surface's default globs are not a selector
  // anyone wrote, so they are not judged.
  const livenessByRule = new Map<IPolicyRule, IPolicyRuleLiveness | undefined>();
  const livenessFor = (rule: IPolicyRule): IPolicyRuleLiveness | undefined => {
    if (livenessByRule.has(rule)) return livenessByRule.get(rule);
    const own = rule.files;
    let value: IPolicyRuleLiveness | undefined;
    if (own !== undefined && own.length > 0 && !malformed.has(rule)) {
      const units = globListUnits(walked, matched.unread, own);
      const liveness = settleUnitLiveness(
        globListLivenessInput({
          subject: rule.id,
          lists: [{ list: 'files', globs: own, units }],
          marks: rule.expectEmptyUnits ?? [],
        }),
      );
      value = { units, liveness };
    }
    livenessByRule.set(rule, value);
    return value;
  };

  // --changed-only SELECTS a rule because a changed PATH matches its globs,
  // but the change may still put nothing in the rule's scope: the path was
  // deleted, or it was read and holds nothing on the rule's surface (a `.ts`
  // with no inline `template:` under a template rule), or it lies where no
  // policy walk goes. That is narrowing — the change cannot have introduced a
  // finding there — so the rule is narrowed out exactly like an unselected
  // one, never reported as a rule that "matched nothing": `failOnEmpty` turns
  // that into a FAILURE, so a pure deletion failed `policy-lint --changed-only`
  // and, once `finish` / `shrk gate` stopped masking a selected rule that
  // examined nothing, would have failed them too. A matched path left UNREAD
  // keeps the rule in scope: PARTIAL, naming the file, never narrowed away.
  const inScope = changedSet
    ? selected.filter(
        (rule) => malformed.has(rule) || unitsFor(rule).length > 0 || readScopeHasUnread(scopeFor(rule)),
      )
    : selected;
  if (inScope.length === 0) return emptyReport();

  const report = evaluatePolicy(inScope, unitsFor, scopeFor, livenessFor);
  // Each rule's units, reported: `evaluatePolicy` emits one result per rule, in
  // order, so the index is the rule. Dead units are the UNMARKED dead ones
  // only — a marked glob is intended-empty (accepted, on `unitAcceptance`) or
  // went-live — and every non-live unit rides along for `--fail-on-dead-units`.
  const skippedIds = new Set(report.skipped.map((s) => s.ruleId));
  const ruleResults = report.rules.map((r, i) => {
    const rule = inScope[i];
    const lv = rule !== undefined ? livenessFor(rule) : undefined;
    if (lv === undefined) return r;
    const settled = lv.liveness;
    const deadSet = new Set(settled.dead.map((u) => u.unit));
    const nonLive = settled.units.filter((u) => u.state !== UnitLivenessState.Live);
    const listed = settled.dead.length + settled.intendedEmpty.length + settled.wentLive.length > 0;
    // A rule its OWN negations emptied is not a stale selector: every file its
    // inclusion globs select was excluded as written.
    const emptied = lv.units.allExcluded && skippedIds.has(r.ruleId);
    return {
      ...r,
      ...(deadSet.size > 0
        ? {
            deadGlobs: lv.units.dead.filter((d) => deadSet.has(d.glob)).map((d) => d.glob),
            deadGlobUnits: lv.units.dead.filter((d) => deadSet.has(d.glob)),
          }
        : {}),
      ...(lv.units.negations.length > 0 ? { negations: lv.units.negations } : {}),
      ...(listed ? { units: unitStateLists(settled) } : {}),
      ...(nonLive.length > 0 ? { unitLiveness: nonLive } : {}),
      ...(emptied
        ? { excludedByNegations: lv.units.negations, coverage: { ...r.coverage, reason: allExcludedCause(lv.units.negations) } }
        : {}),
    };
  });
  return { ...report, rules: ruleResults };

  function resolveUnits(rule: IPolicyRule): readonly IPolicyUnit[] {
    if (malformed.has(rule)) return [];
    const globs = globsFor(rule);
    // `exemptFiles` never removes the file from the scan — it MARKS it, so the
    // hits it would have produced are reported as suppressed rather than
    // vanishing. A silently-dropped exemption is indistinguishable from a stale
    // glob, which is the failure mode this whole plane exists to prevent.
    const exempt = rule.exemptFiles && rule.exemptFiles.length > 0 ? rule.exemptFiles : undefined;
    const units: IPolicyUnit[] = [];
    for (const [path, content] of cache) {
      if (changedSet && !changedSet.has(path)) continue;
      // `files` `!` EXCLUDES (the file is out of scope); `exemptFiles` MARKS.
      if (!globListSelects(path, globs)) continue;
      const exemptFile = exempt !== undefined && globListSelects(path, exempt);
      const ext = nodePath.extname(path).toLowerCase();
      if (rule.surface === 'template' && SOURCE_EXT.has(ext)) {
        for (const tpl of extractInlineTemplates(content)) {
          units.push({
            path,
            content: tpl.body,
            baseLine: tpl.startLine,
            inlineTemplate: true,
            ...(exemptFile ? { exemptFile: true } : {}),
          });
        }
      } else {
        // .html on the template surface, and all style/ts files: scan whole.
        units.push({ path, content, baseLine: 1, ...(exemptFile ? { exemptFile: true } : {}) });
      }
    }
    return units;
  }
}
