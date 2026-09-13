/**
 * THE knowledge stale-check verdict — decided once, from the one report.
 *
 * `shrk knowledge stale-check` / `verify` settle it through `buildGateEnvelope`;
 * `shrk quality`, `shrk release readiness` and every `buildQualityReport`
 * consumer (MCP `get_quality_report`, the dashboard, the report site) through
 * `settleKnowledgeStaleGate`. All of them call this, so the corpus verdict an
 * agent chains on and the one the pre-push bundle folds cannot disagree.
 * (Round 11 review: it lived in the CLI, so the MCP report — which cannot
 * import the CLI — had no knowledge gate at all and read `pass` over a stale
 * corpus `shrk quality` failed.)
 *
 * STRICT BY DEFAULT: every in-scope entry the check could not examine (no
 * checkable `references[]` / `anchors[]`) is a coverage shortfall on the
 * verdict, so a run with any unverifiable entry settles to `2` (not verified)
 * — never `0`. The only ways to a `0` over an unverifiable remainder are
 * explicit and printed: `--min-referenced <ratio>` (or
 * `knowledgeCheck.minReferenced`) accepts the remainder when the examined share
 * is at least the ratio, and fails the run below it; `--allow-empty` accepts a
 * legitimately EMPTY scope only.
 */
import type { ISharkCraftConfig } from '@shrkcrft/config';
import { ruleVerdictRecords, settleVerdict, type ISettledVerdict, type IVerdictCoverage } from '@shrkcrft/core';
import { formatKnowledgeReference } from '@shrkcrft/knowledge';
import { declaredReferenceCoverage } from './declared-reference-coverage.ts';
import type { IInspectionDiscovery } from './inspection-discovery.ts';
import { KnowledgeEntryVerdict } from './knowledge-entry-verdict.ts';
import type { IKnowledgeLoadFailure } from './knowledge-load-failure.ts';
import { ReferenceCheckOutcome, type IKnowledgeStaleReport } from './knowledge-stale.ts';
import type { IKnowledgeStaleGateFlags } from './knowledge-stale-gate-flags.ts';
import type { IKnowledgeStaleGateInput } from './knowledge-stale-gate-input.ts';
import type { IKnowledgeStaleGate } from './knowledge-stale-gate-result.ts';
import type { IKnowledgeStaleGateRule } from './knowledge-stale-gate-rule.ts';
import type { IKnowledgeStaleGateViolation } from './knowledge-stale-gate-violation.ts';
import { KnowledgeMinReferencedValve } from './knowledge-min-referenced-valve.ts';
import { REJECTED_AT_LOAD } from './knowledge-entry-rejections.ts';
import { unverifiableEntryRemedy, unverifiableRemedy } from './knowledge-unverifiable-remedy.ts';
import { ReferenceFailure } from './reference-failure.ts';

/** The stale-check rule of the knowledge entries the loader refused (round 15 follow-up, F3). */
export const KNOWLEDGE_REJECTED_RULE_ID = 'knowledge-rejected-entries';

/** The proposed exits (the CLI's `ExitCode` values; the inspector cannot import the CLI). */
const VERIFIED_PASS = 0;
const FAILURE = 1;
const NOT_VERIFIED = 2;

/**
 * Every `--fail-on` category. `all` keeps its historical meaning (any stale or
 * missing reference); the round-11 categories are opt-in BY NAME, so no
 * existing `--fail-on all` pipeline changes behaviour. (A MALFORMED reference
 * is never a pass in any mode — it is a coverage shortfall, exit 2;
 * `--fail-on invalid` makes it a failure, exit 1.)
 */
export const KNOWLEDGE_FAIL_ON_CATEGORIES: readonly string[] = [
  'required',
  'stale',
  'missing',
  'all',
  'unverifiable',
  'invalid',
  'path-missing',
  'anchor-missing',
  'content',
  'count',
  'aged',
  'implicit',
];

/** Unexamined entry ids carried on the coverage record (the full list is in the JSON). */
const COVERAGE_LABEL_CAP = 20;

/** Parse `--min-referenced`: a ratio `0..1` or a percentage `NN%`. `null` when malformed. */
export function parseMinReferenced(raw: string): number | null {
  const s = raw.trim();
  const pct = /^(\d+(?:\.\d+)?)%$/.exec(s);
  const n = pct ? Number(pct[1]) / 100 : /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(s) ? Number(s) : Number.NaN;
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

/** `0.266…` → `26.7%`, `1` → `100%`. */
export function formatPct(ratio: number): string {
  const v = Math.round(ratio * 1000) / 10;
  return `${Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1)}%`;
}

function isFailing(o: ReferenceCheckOutcome): boolean {
  return o === ReferenceCheckOutcome.Stale || o === ReferenceCheckOutcome.Missing;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Load failures named in prose before the rest are summarised. */
const LOAD_FAILURES_NAMED = 3;

/** `sharkcraft/rules.ts (failed: SyntaxError …)` / `sharkcraft/k.ts (missing)`. */
function loadFailureLabel(f: IKnowledgeLoadFailure): string {
  return `${f.file} (${f.status === 'missing' ? 'missing' : `${f.status}: ${f.message}`})`;
}

/** The first few failed knowledge files, `; `-joined, with `(+N more)`. */
function loadFailureList(failures: readonly IKnowledgeLoadFailure[]): string {
  const named = failures.slice(0, LOAD_FAILURES_NAMED).map(loadFailureLabel).join('; ');
  return failures.length > LOAD_FAILURES_NAMED ? `${named} (+${failures.length - LOAD_FAILURES_NAMED} more)` : named;
}

/** Why the scope is empty — the run coverage's reason, in the reader's terms. */
function emptyScopeReason(report: IKnowledgeStaleReport, input: IKnowledgeStaleGateInput): string {
  const d = input.discovery;
  if (d.sharkcraftDir === null) {
    return d.configuredAncestor
      ? `no sharkcraft/ folder at the resolved root — ${d.configuredAncestor} has one: rerun with --cwd ${d.configuredAncestor}`
      : 'no sharkcraft/ folder at the resolved root';
  }
  if (d.configError !== undefined) {
    return `sharkcraft.config.ts failed to load (${d.configError}), so no knowledge was loaded`;
  }
  const failed = d.knowledgeLoadFailures;
  if (report.entries === 0 && failed.length > 0) {
    return `${plural(failed.length, 'knowledge file', 'knowledge files')} never loaded — ${loadFailureList(failed)} — so no knowledge was loaded`;
  }
  // Round 15 follow-up (F3): entries WERE declared — the loader refused them all.
  if (report.entries === 0 && report.rejectedEntries.length > 0) {
    return `every declared knowledge entry (${report.rejectedEntries.length}) was rejected at load, so none was checked`;
  }
  if (report.entries === 0) return 'no knowledge entries are declared';
  const alsoFailed =
    failed.length > 0 ? `, and ${plural(failed.length, 'knowledge file', 'knowledge files')} never loaded (${loadFailureList(failed)})` : '';
  return `none of the ${report.entries} knowledge entries references the changed files${alsoFailed}`;
}

/**
 * Decide the stale-check verdict inputs. Pure: the report, the flags, the
 * discovery — nothing else.
 */
export function evaluateKnowledgeStaleGate(
  report: IKnowledgeStaleReport,
  input: IKnowledgeStaleGateInput,
): IKnowledgeStaleGate {
  const cov = report.coverage;
  const failOn = input.failOn;
  const consider = (cat: string): boolean => failOn.has(cat) || failOn.has('all');

  let requiredStale = 0;
  let requiredMissing = 0;
  for (const c of report.referenceChecks) {
    if (c.reference.required !== true) continue;
    if (c.outcome === ReferenceCheckOutcome.Stale) requiredStale += 1;
    if (c.outcome === ReferenceCheckOutcome.Missing) requiredMissing += 1;
  }
  const requiredFailing = requiredStale + requiredMissing;
  // Declared references on boundary rules / policy checks count like a
  // knowledge entry's. Implicit ones (a scope glob's dead prefix) are advisory
  // unless `--fail-on implicit`.
  const assetFailing = report.assetReferenceChecks.filter((c) => !c.implicit && isFailing(c.outcome));
  const implicitFailing = report.assetReferenceChecks.filter((c) => c.implicit === true && isFailing(c.outcome));
  // Every DECLARED reference (knowledge, anchor, boundary rule, policy) is one
  // population: checkable ones were examined, malformed ones never were.
  const declaredRefs = [...report.referenceChecks, ...report.assetReferenceChecks.filter((c) => !c.implicit)];
  const invalidRefs = declaredRefs.filter((c) => c.outcome === ReferenceCheckOutcome.Invalid);
  const invalidAnchors = report.anchorChecks.filter((a) => a.outcome === ReferenceCheckOutcome.Invalid);
  const invalidCount = invalidRefs.length + invalidAnchors.length;
  // Round 15 follow-up (F3): entries the LOADER refused. INVALID-class: never
  // in scope, never checked — a coverage shortfall of their own rule (exit 2),
  // a failure under `--fail-on invalid` (exit 1). No valve accepts them:
  // `--min-referenced` accepts the run's unverifiable remainder and
  // `--allow-empty` an empty scope, never this rule.
  const rejected = report.rejectedEntries;

  const reasons: string[] = [];
  // The historical modes, unchanged (they are mutually exclusive by design).
  if (input.ci) {
    if (requiredFailing > 0) reasons.push(`${requiredFailing} required references failing in --ci mode`);
  } else if (input.strict) {
    if (requiredFailing > 0) reasons.push(`${requiredFailing} required references failing in --strict mode`);
  } else if (failOn.size > 0) {
    if (consider('required') && requiredFailing > 0) {
      reasons.push(`${requiredFailing} required reference issues (--fail-on=required)`);
    }
    if (consider('stale') && report.counts.stale > 0) {
      reasons.push(`${report.counts.stale} stale references (--fail-on=stale)`);
    }
    if (consider('missing') && report.counts.missing > 0) {
      reasons.push(`${report.counts.missing} missing references (--fail-on=missing)`);
    }
    if (failOn.has('all') && assetFailing.length > 0) {
      reasons.push(`${assetFailing.length} stale boundary-rule / policy references (--fail-on=all)`);
    }
  } else {
    const n = report.counts.missing + report.counts.stale + assetFailing.length;
    if (n > 0) reasons.push(`${n} stale or missing references (legacy default)`);
  }
  // The round-11 categories — each opt-in by name.
  const byFailure = (f: ReferenceFailure): number => report.failureCounts[f] ?? 0;
  if (failOn.has('path-missing') && byFailure(ReferenceFailure.PathMissing) > 0) {
    reasons.push(`${byFailure(ReferenceFailure.PathMissing)} path-missing references (--fail-on=path-missing)`);
  }
  if (failOn.has('anchor-missing') && byFailure(ReferenceFailure.AnchorMissing) > 0) {
    reasons.push(`${byFailure(ReferenceFailure.AnchorMissing)} anchor-missing references (--fail-on=anchor-missing)`);
  }
  if (failOn.has('content') && byFailure(ReferenceFailure.ContentMismatch) > 0) {
    reasons.push(`${byFailure(ReferenceFailure.ContentMismatch)} content assertions no longer hold (--fail-on=content)`);
  }
  if (failOn.has('count') && byFailure(ReferenceFailure.CountMismatch) > 0) {
    reasons.push(`${byFailure(ReferenceFailure.CountMismatch)} counts re-derived to a different number (--fail-on=count)`);
  }
  if (failOn.has('aged') && (report.age?.aged.length ?? 0) > 0) {
    reasons.push(`${report.age!.aged.length} entries not verified within ${report.age!.staleAfterDays}d (--fail-on=aged)`);
  }
  if (failOn.has('implicit') && implicitFailing.length > 0) {
    reasons.push(`${implicitFailing.length} boundary-rule scope globs point at nothing (--fail-on=implicit)`);
  }
  if (failOn.has('invalid') && invalidCount > 0) {
    reasons.push(`${plural(invalidCount, 'malformed reference', 'malformed references')} (--fail-on=invalid)`);
  }
  if (failOn.has('invalid') && rejected.length > 0) {
    reasons.push(`${plural(rejected.length, 'knowledge entry', 'knowledge entries')} rejected at load (--fail-on=invalid)`);
  }
  const requireRefs = input.requireReferences || failOn.has('unverifiable');
  if (requireRefs && cov.unverifiable > 0) {
    reasons.push(
      `${plural(cov.unverifiable, 'entry declares', 'entries declare')} no checkable reference (--require-references)`,
    );
  }
  if (input.minReferenced && cov.entriesInScope > 0 && cov.referencedRatio < input.minReferenced.ratio) {
    reasons.push(
      `reference coverage ${formatPct(cov.referencedRatio)} < ${formatPct(input.minReferenced.ratio)} (${input.minReferenced.acceptedBy})`,
    );
  }

  const d = input.discovery;
  const loadFailures = d.knowledgeLoadFailures;
  // A load failure is a discovery failure at ANY corpus size: the entries of a
  // file that never loaded were never checked, so neither a clean sweep of the
  // rest nor `--allow-empty` can make the run a pass.
  const discoveryFailed =
    (d.entriesLoaded === 0 && (d.sharkcraftDir === null || d.configError !== undefined)) || loadFailures.length > 0;
  const examined = cov.verified + cov.stale;

  // Propose from what was found. An EMPTY scope proposes 0 and lets the run
  // coverage (expected 0) settle it — that is what keeps `--allow-empty`
  // reachable. A non-empty scope that examined nothing proposes 2 outright.
  const proposed =
    reasons.length > 0
      ? FAILURE
      : cov.entriesInScope > 0 && examined === 0
        ? NOT_VERIFIED
        : VERIFIED_PASS;

  const acceptance: Pick<IVerdictCoverage, 'acceptedBy' | 'acceptedRatio'> =
    cov.entriesInScope === 0
      ? discoveryFailed
        ? {}
        : input.emptyAcceptance
      : input.minReferenced
        ? { acceptedBy: input.minReferenced.acceptedBy, acceptedRatio: input.minReferenced.ratio }
        : {};
  const runCoverage: IVerdictCoverage = {
    unit: 'knowledge entries',
    expected: cov.entriesInScope,
    examined,
    ...(report.unverifiableIds.length > 0
      ? {
          unexamined: report.unverifiableIds.slice(0, COVERAGE_LABEL_CAP),
          unexaminedTotal: report.unverifiableIds.length,
        }
      : {}),
    root: d.resolvedRoot,
    reason:
      cov.entriesInScope === 0
        ? emptyScopeReason(report, input)
        : 'declare no checkable references[] or anchors[], so they were never checked',
    ...acceptance,
  };

  // THE waiver (round 13): references that FAIL (stale / missing) but block
  // nothing in this mode — `required: false` under --ci / --strict (they fail on
  // required references only), or outside the chosen --fail-on categories. They
  // are printed as STALE / MISSING rows, and the ✓ line used to stand over them
  // in silence ("no stale or missing references"). Recorded as an acceptance
  // next to the rule's coverage, so it is printed in `accepted` at exit 0 —
  // never a shortfall, never a failure.
  const failingLabels = [
    ...[...report.referenceChecks, ...assetFailing]
      .filter((c) => isFailing(c.outcome))
      .map((c) => `${c.entryId} → ${formatKnowledgeReference(c.reference)}`),
    ...report.anchorChecks.filter((a) => isFailing(a.outcome)).map((a) => `${a.entryId} anchor ${a.anchor.id}`),
  ];
  const waivedBy =
    reasons.length > 0 || failingLabels.length === 0
      ? undefined
      : input.ci
        ? 'required: false (--ci fails on required references only)'
        : input.strict
          ? 'required: false (--strict fails on required references only)'
          : failOn.size > 0
            ? `the fail-on categories (${[...failOn].join(', ')})`
            : 'the legacy default (it fails on stale or missing references, not on anchors)';
  const waiver: IVerdictCoverage | undefined =
    waivedBy === undefined
      ? undefined
      : {
          unit: 'failing references',
          expected: failingLabels.length,
          examined: 0,
          unexamined: failingLabels.slice(0, COVERAGE_LABEL_CAP),
          unexaminedTotal: failingLabels.length,
          reason: 'stale or missing, and waived — this mode does not fail on them',
          acceptedBy: waivedBy,
        };

  const rules: IKnowledgeStaleGateRule[] = [];
  if (cov.entriesInScope > 0) {
    const violations: IKnowledgeStaleGateViolation[] = [];
    // The file declaring each knowledge entry — a violation names the file to
    // edit (round 15: a Markdown entry's, its .md).
    const declaredIn = new Map(report.entryVerdicts.map((v) => [v.entryId, v.source]));
    for (const c of [...report.referenceChecks, ...assetFailing, ...(failOn.has('implicit') ? implicitFailing : [])]) {
      if (!isFailing(c.outcome)) continue;
      const file = c.assetKind ? undefined : declaredIn.get(c.entryId);
      violations.push({
        id: c.entryId,
        ...(file !== undefined ? { file } : {}),
        message: `${formatKnowledgeReference(c.reference)} — ${c.message}`,
        ...(c.suggestion ? { hint: c.suggestion } : {}),
      });
    }
    for (const a of report.anchorChecks) {
      if (!isFailing(a.outcome)) continue;
      violations.push({ id: a.entryId, message: `anchor ${a.anchor.id} (${a.anchor.kind}) — ${a.message}` });
    }
    if (failOn.has('invalid')) {
      for (const c of invalidRefs) {
        violations.push({ id: c.entryId, message: `MALFORMED ${formatKnowledgeReference(c.reference)} — ${c.message}` });
      }
      for (const a of invalidAnchors) {
        violations.push({ id: a.entryId, message: `MALFORMED anchor ${a.anchor.id} — ${a.message}` });
      }
    }
    if (requireRefs) {
      for (const v of report.entryVerdicts) {
        if (v.verdict !== KnowledgeEntryVerdict.Unverifiable) continue;
        violations.push({
          id: v.entryId,
          file: v.source,
          // THE per-entry remedy (round 15 closing, A4): an entry whose
          // references exist but are malformed read "declare references[]".
          message: `UNVERIFIABLE (${v.reason ?? 'no checkable reference'}) — ${unverifiableEntryRemedy(v)}`,
        });
      }
    }
    rules.push({
      id: 'knowledge-references',
      type: 'knowledge',
      status: reasons.length > 0 ? 'failed' : examined === 0 ? 'skipped' : 'passed',
      severity: 'error',
      counts: {
        entries: cov.entriesInScope,
        verified: cov.verified,
        stale: cov.stale,
        unverifiable: cov.unverifiable,
        references: report.totalReferences,
        anchors: report.totalAnchors,
      },
      violations,
      ...(examined === 0
        ? {
            skipReason: `no entry in scope declares a checkable reference (${plural(cov.unverifiable, 'entry', 'entries')} unverifiable)`,
          }
        : {}),
      // THE declared-reference fold (`declaredReferenceCoverage`, shared with
      // the `shrk gate` knowledge-symbol gate): a malformed reference was
      // declared to be checked and never was — expected, not examined — so a
      // run with one is never a clean pass.
      coverage: declaredReferenceCoverage({ references: declaredRefs, anchors: report.anchorChecks }),
      ...(waiver !== undefined ? { unitAcceptance: waiver } : {}),
    });
  }

  // Round 15 follow-up (F3): knowledge entries the loader REFUSED — their own
  // rule, pushed at ANY scope and corpus size (a clean sweep of the rest, a
  // changeset, `--allow-empty` or `--min-referenced` never covers them). By
  // default `skipped` — nothing was checked, the shortfall settles the run to
  // 2 — and `failed` under `--fail-on invalid`, the INVALID-class contract of a
  // malformed reference.
  if (rejected.length > 0) {
    const failing = failOn.has('invalid');
    rules.push({
      id: KNOWLEDGE_REJECTED_RULE_ID,
      type: 'knowledge',
      status: failing ? 'failed' : 'skipped',
      severity: 'error',
      counts: { rejected: rejected.length },
      violations: failing
        ? rejected.map((r) => ({
            id: r.label,
            file: r.source,
            message: `REJECTED AT LOAD${r.pack !== undefined ? ` (pack ${r.pack})` : ''} — ${r.message}`,
          }))
        : [],
      ...(failing
        ? {}
        : { skipReason: `${plural(rejected.length, 'knowledge entry was', 'knowledge entries were')} rejected at load — never checked` }),
      coverage: {
        unit: 'knowledge entries',
        expected: rejected.length,
        examined: 0,
        unexamined: rejected.slice(0, COVERAGE_LABEL_CAP).map((r) => r.label),
        unexaminedTotal: rejected.length,
        reason: `${REJECTED_AT_LOAD} — the loader refused them (\`shrk self-config doctor\` names why); no valve accepts them`,
      },
    });
  }

  // Knowledge-bearing files that never loaded: their own rule, so the envelope
  // names each one and the shortfall rides into the settled verdict whatever
  // the rest of the corpus proved. `error` — a source that could not be read is
  // never `evaluated`.
  if (loadFailures.length > 0) {
    const attempted = Math.max(d.knowledgeFilesAttempted, loadFailures.length);
    rules.push({
      id: 'knowledge-files',
      type: 'knowledge',
      status: 'error',
      severity: 'error',
      counts: { files: attempted, loaded: attempted - loadFailures.length, failed: loadFailures.length },
      violations: loadFailures.map((f) => ({
        id: f.file,
        file: f.file,
        message: `${f.kind} file ${f.status === 'missing' ? 'MISSING' : 'FAILED TO LOAD'}${f.packName ? ` (pack ${f.packName})` : ''} — ${f.message}`,
      })),
      error: `${plural(loadFailures.length, 'knowledge file', 'knowledge files')} never loaded: ${loadFailureList(loadFailures)}`,
      coverage: {
        unit: 'knowledge files',
        expected: attempted,
        examined: attempted - loadFailures.length,
        unexamined: loadFailures.slice(0, COVERAGE_LABEL_CAP).map((f) => f.file),
        unexaminedTotal: loadFailures.length,
        reason: 'failed to load (or are declared and missing), so their entries were never checked',
      },
    });
  }

  // A refused entry's sentence rides next to whichever lead the run has — it is
  // never the whole story, and never dropped from it (round 15 follow-up, F3).
  const rejectedLead =
    rejected.length > 0
      ? `${plural(rejected.length, 'knowledge entry was', 'knowledge entries were')} rejected at load and never checked (listed above as INVALID): ${rejected
          .slice(0, LOAD_FAILURES_NAMED)
          .map((r) => r.label)
          .join(', ')}${rejected.length > LOAD_FAILURES_NAMED ? ` (+${rejected.length - LOAD_FAILURES_NAMED} more)` : ''} — fix each (\`shrk self-config doctor\` names why); \`--fail-on invalid\` makes this a failure, and no valve accepts it.`
      : undefined;
  const loadLead =
    loadFailures.length > 0
      ? `${plural(loadFailures.length, 'knowledge file', 'knowledge files')} never loaded, so ${
          loadFailures.length === 1 ? 'its entries were' : 'their entries were'
        } never checked: ${loadFailureList(loadFailures)}. Fix the file (\`shrk doctor\` names the error) — --allow-empty never accepts a load failure.`
      : undefined;
  const restLead =
    loadFailures.length > 0
      ? undefined
      : discoveryFailed
        ? `Loaded 0 knowledge entries from ${d.resolvedRoot} — nothing was checked.`
        : cov.entriesInScope > 0 && cov.unverifiable > 0
          ? `${plural(cov.unverifiable, 'entry', 'entries')} of ${cov.entriesInScope} (${formatPct(
              cov.unverifiable / cov.entriesInScope,
            )}) ${cov.unverifiable === 1 ? 'declares' : 'declare'} no checkable reference, so ${
              cov.unverifiable === 1 ? 'it was' : 'they were'
            } never checked. ${unverifiableRemedy(report.entryVerdicts, KnowledgeMinReferencedValve.Flag)}`
          : invalidCount > 0
            ? `${plural(invalidCount, 'reference is', 'references are')} MALFORMED (listed above as INVALID) and ${
                invalidCount === 1 ? 'was' : 'were'
              } never checked — fix the kind or the missing field; \`--fail-on invalid\` makes this a failure.`
            : undefined;
  const leads = [loadLead, rejectedLead, restLead].filter((l): l is string => l !== undefined);
  const notVerifiedLead = leads.length > 0 ? leads.join(' ') : undefined;

  return {
    proposed,
    reasons,
    requiredStale,
    requiredMissing,
    rules,
    runCoverage,
    discoveryFailed,
    waived: cov.entriesInScope > 0 && waiver !== undefined ? waiver.expected : 0,
    ...(notVerifiedLead ? { notVerifiedLead } : {}),
  };
}

/**
 * A request whose `aged` category (or `--as-of`) has no `--stale-after` window
 * to measure against can never fire — the vacuous-category class `--fail-on
 * bogus` is refused for. `undefined` when the request is well-formed.
 */
export function knowledgeStaleWindowProblem(
  failOn: ReadonlySet<string>,
  agedFromConfig: boolean,
  staleAfterDays: number | undefined,
  asOf: string | undefined,
): string | undefined {
  if (staleAfterDays !== undefined) return undefined;
  if (asOf !== undefined) {
    return '--as-of dates the --stale-after window; without --stale-after <Nd|Nw|Nm|Ny> it measures nothing.';
  }
  if (!failOn.has('aged')) return undefined;
  return agedFromConfig
    ? "knowledgeCheck.failOn includes 'aged', which needs a --stale-after <Nd|Nw|Nm|Ny> window — without one no entry can be aged, so the category could never fail. Pass --stale-after, or drop 'aged' from knowledgeCheck.failOn."
    : '--fail-on aged needs --stale-after <Nd|Nw|Nm|Ny>: without a window no entry can be aged, so the category could never fail.';
}

/**
 * THE stale-check input — the verb's flags folded over the config's
 * `knowledgeCheck` block. `shrk knowledge stale-check`, `shrk quality`, `shrk
 * release readiness` and `buildQualityReport` all build their input here, so
 * for a config-only request the verb's exit, the quality gate and
 * `knowledgeCheck.ready` are one answer (they used to read the block three
 * different ways).
 *
 * Precedence (a flag wins):
 *   - `--fail-on` replaces `knowledgeCheck.failOn` wholesale;
 *   - `knowledgeCheck.strict: true` ("promote any stale to a failure") adds
 *     `all` to the config's list; the verb's `--strict` / `--ci` (the R30
 *     required-only modes) take precedence over any `failOn`;
 *   - `--min-referenced` over `knowledgeCheck.minReferenced` (each printed as
 *     its own acceptance);
 *   - `--require-references` OR `knowledgeCheck.requireReferences`;
 *   - `--allow-empty` is a flag only — never read from config.
 */
export function knowledgeStaleGateInput(o: {
  readonly flags: IKnowledgeStaleGateFlags;
  readonly knowledgeCheck: ISharkCraftConfig['knowledgeCheck'];
  readonly discovery: IInspectionDiscovery;
  readonly scoped: boolean;
}): IKnowledgeStaleGateInput {
  const f = o.flags;
  const cfg = o.knowledgeCheck;
  const flagFailOn = f.failOn ?? [];
  const fromConfig = flagFailOn.length === 0;
  const configFailOn: readonly string[] = cfg?.failOn ?? [];
  const failOn = new Set<string>(fromConfig ? configFailOn : flagFailOn);
  if (fromConfig && cfg?.strict === true) failOn.add('all');
  const minReferenced =
    f.minReferenced ??
    (cfg?.minReferenced !== undefined
      ? { ratio: cfg.minReferenced, acceptedBy: `knowledgeCheck.minReferenced: ${cfg.minReferenced}` }
      : undefined);
  const usageProblem = knowledgeStaleWindowProblem(
    failOn,
    fromConfig && configFailOn.includes('aged'),
    f.staleAfterDays,
    f.asOf,
  );
  return {
    ci: f.ci === true,
    strict: f.strict === true,
    failOn,
    ...(minReferenced ? { minReferenced } : {}),
    requireReferences: f.requireReferences === true || cfg?.requireReferences === true,
    emptyAcceptance: f.emptyAcceptance ?? {},
    scoped: o.scoped,
    discovery: o.discovery,
    ...(usageProblem ? { usageProblem } : {}),
  };
}

/**
 * Settle a stale-check verdict WITHOUT an envelope (`shrk quality`, `shrk
 * release readiness`, `buildQualityReport`) — exactly the fold
 * `buildGateEnvelope` applies for the verb: the run coverage plus every rule's
 * coverage, subject = rule id.
 */
export function settleKnowledgeStaleGate(gate: IKnowledgeStaleGate): ISettledVerdict {
  return settleVerdict(gate.proposed, [
    gate.runCoverage,
    // THE fold the envelope applies (round 13): a rule's acceptance rides next
    // to its coverage (`ruleVerdictRecords`), so quality prints the same waiver.
    ...gate.rules.flatMap((r) =>
      ruleVerdictRecords(r.coverage, r.unitAcceptance).map((c) => ({ ...c, subject: c.subject ?? r.id })),
    ),
  ]);
}
