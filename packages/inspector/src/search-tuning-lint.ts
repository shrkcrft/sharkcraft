/**
 * THE search-tuning lint — consumed by `shrk search tuning doctor` AND the
 * self-config doctor (one lint, two renderers).
 *
 * `search tuning doctor` used to report only load/clamp issues, so it printed
 * "No issues." and exited 0 over a dead bare key, a misspelled prefix, a missing
 * target, triggers no query can produce, and a silent total-cap discard. Every
 * check here is deterministic over data already loaded:
 *
 *   - boost keys resolve through THE key resolver (`target-missing`,
 *     `key-unprefixed`, `key-unknown-kind`), deduped per (entry, key) — THE key
 *     probes (`searchTuningKeyProbes`);
 *   - a key whose document kind the entry's `appliesToKinds` excludes;
 *   - task-hint triggers: unreachable (`unreachable-trigger`) and identical
 *     trigger sets within one entry (`duplicate-trigger`);
 *   - `appliesToKinds` / `boostKinds` / `boostSources` naming no search kind or
 *     source;
 *   - the global ±cap discarding composed tuning (`cap-discards`, info).
 *
 * Dead units (a key that never fires, a hint that never applies) and
 * unverifiable keys are reported as COVERAGE, so a verdict built on this lint
 * can never read as a pass over them. Round 13: every unit is settled through
 * THE liveness authority (`settleUnitLiveness`): a missing target whose every
 * declaration is marked `{ weight, expectEmpty: true }` is intended-empty (an
 * `acceptedBy: expectEmpty` acceptance, printed), and a marked key that now
 * resolves went live (reported, never silently accepted).
 */
import {
  DEAD_SELECTOR_CAUSES,
  MARKABLE_UNIT_LISTS,
  MarkableUnitList,
  settleUnitLiveness,
  UnitDeadCause,
  UnitDeadWeight,
  UnitLivenessState,
  type ISettledUnitLiveness,
  type IUnitLiveness,
  type IUnitMark,
  type IUnitObservation,
} from '@shrkcrft/core';
import type { ISearchTuningKeyProbe } from './i-search-tuning-key-probe.ts';
import type { ISearchTuningLintIssue } from './i-search-tuning-lint-issue.ts';
import type { ISearchTuningLintReport } from './i-search-tuning-lint-report.ts';
import { nearestIds } from './nearest-id.ts';
import { warmReferenceRegistries } from './reference-registry.ts';
import { searchDocumentReference } from './search-document-id.ts';
import { buildSearchIndex, SearchKind, SearchSource } from './search-index.ts';
import type { ISearchTuningKeyResolution } from './search-tuning-key-resolution.ts';
import { searchTuningKeyProbes } from './search-tuning-key-probes.ts';
import { SearchTuningKeyStatus } from './search-tuning-key-status.ts';
import {
  loadSearchTuning,
  SEARCH_TUNING_BOOST_IDS,
  SEARCH_TUNING_TOTAL_CAP,
  tuningBoostFor,
  type ISearchTuningEntry,
} from './search-tuning-registry.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import { isReachableTuningTrigger } from './tuning-query-tokens.ts';

/** `cap-discards` issues before the rest collapse into one summary line. */
const CAP_DISCARD_ISSUE_CAP = 20;
const COVERAGE_SUBJECT = 'search tuning';
/** The observation list of a task hint (not markable — an unreachable trigger can never go live). */
const TASK_HINTS_LIST = 'taskHints';

const SEARCH_KINDS: readonly string[] = Object.values(SearchKind);
const SEARCH_SOURCES: readonly string[] = Object.values(SearchSource);

function signed(n: number): string {
  return `${n > 0 ? '+' : ''}${n}`;
}

/**
 * One distinct boost key, observed. Existence is the key RESOLVING; liveness
 * adds that some declaring entry's `appliesToKinds` admits it. A key that can
 * never fire whatever exists — unprefixed, an unknown kind, excluded by every
 * declaring entry — is dead by SHAPE (`cause`): never markable.
 */
function keyObservation(key: string, list: string, r: ISearchTuningKeyResolution, admitted: boolean): IUnitObservation {
  const excluded = { cause: UnitDeadCause.Defect, deadReason: "its entry's appliesToKinds excludes the document's kind, so the boost never fires" };
  switch (r.status) {
    case SearchTuningKeyStatus.Resolved:
      return admitted
        ? { list, unit: key, label: key, exists: true, live: true, liveBecause: `${r.referenceKind ?? 'the document'} "${r.id}" is registered` }
        : { list, unit: key, label: `${key} (excluded by appliesToKinds)`, exists: true, live: false, ...excluded };
    case SearchTuningKeyStatus.Missing:
      return {
        list,
        unit: key,
        label: `${key} (missing)`,
        exists: false,
        live: false,
        deadReason: `no ${r.referenceKind ?? 'document'} "${r.id}" is registered`,
        ...(admitted ? {} : { cause: UnitDeadCause.Defect }),
      };
    case SearchTuningKeyStatus.Unverified:
      return { list, unit: key, label: key, exists: undefined, live: undefined, ...(r.reason ? { deadReason: r.reason } : {}) };
    default:
      return {
        list,
        unit: key,
        label: `${key} (${r.status})`,
        exists: false,
        live: false,
        cause: UnitDeadCause.Defect,
        deadReason: r.reason ?? 'a boost key is a search-document id `<kind>:<id>`, so it never matches a document',
      };
  }
}

/**
 * The marker a distinct key settles with — a reporter's aggregation over its
 * declarations, never a state decision (THE settle decides). A missing target
 * is intended-empty only when EVERY declaration of it is marked: an unmarked
 * one is a boost that never fires, so the key stays judged. Any marker on a key
 * that resolves is stale (went live) and is reported; a local marker is chosen
 * over a pack one, so a stale LOCAL marker fails under `--fail-on-dead-units`.
 */
function keyMark(
  key: string,
  list: string,
  declarations: readonly ISearchTuningKeyProbe[],
  live: boolean,
): IUnitMark | undefined {
  const marks = declarations.flatMap((d) => d.marks);
  if (marks.length === 0) return undefined;
  const everyDeclarationMarked = declarations.every((d) => d.marks.length === d.lists.length);
  if (!everyDeclarationMarked && !live) return undefined;
  const pick = marks.find((m) => m.packageName === undefined) ?? marks[0]!;
  return {
    list,
    unit: key,
    ...(pick.reason !== undefined ? { reason: pick.reason } : {}),
    ...(pick.packageName !== undefined ? { packageName: pick.packageName } : {}),
  };
}

/** THE settle over every distinct boost key (Coverage weight: a dead key is a shortfall). */
function settleKeys(probes: readonly ISearchTuningKeyProbe[]): {
  readonly settled: ISettledUnitLiveness;
  readonly unitOf: ReadonlyMap<string, IUnitLiveness>;
} {
  const byKey = new Map<string, ISearchTuningKeyProbe[]>();
  for (const p of probes) byKey.set(p.key, [...(byKey.get(p.key) ?? []), p]);
  const observations: IUnitObservation[] = [];
  const marks: IUnitMark[] = [];
  for (const [key, declarations] of byKey) {
    const first = declarations[0]!;
    const r = first.resolution;
    const admitted = declarations.some((d) => d.excludedKind === undefined);
    const list = first.lists[0] ?? SEARCH_TUNING_BOOST_IDS;
    observations.push(keyObservation(key, list, r, admitted));
    const mark = keyMark(key, list, declarations, r.status === SearchTuningKeyStatus.Resolved && admitted);
    if (mark) marks.push(mark);
  }
  const settled = settleUnitLiveness({
    subject: COVERAGE_SUBJECT,
    unitLabel: MARKABLE_UNIT_LISTS[MarkableUnitList.SearchTuningBoostIds].unitLabel,
    weight: UnitDeadWeight.Coverage,
    observations,
    marks,
    deadSummary: 'never fire or could not be checked',
  });
  return { settled, unitOf: new Map(settled.units.map((u) => [u.unit, u])) };
}

/**
 * Per key, every declaration that does NOT mark it (`<tuning id> <map>`) — why
 * a marker on a missing target is not honoured (`keyMark`: an unmarked
 * declaration is a boost that never fires, so the key stays judged). Named on
 * the marked declaration's finding, so an ignored marker is never silent.
 */
function unmarkedDeclarations(probes: readonly ISearchTuningKeyProbe[]): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, string[]>();
  for (const p of probes) {
    const marked = new Set(p.marks.map((m) => m.list));
    for (const list of p.lists) {
      if (!marked.has(list)) out.set(p.key, [...(out.get(p.key) ?? []), `${p.tuningId} ${list}`]);
    }
  }
  return out;
}

/** One finding per (entry, key) — the same key in three task hints used to be three identical warnings. */
function lintKeys(
  probes: readonly ISearchTuningKeyProbe[],
  unitOf: ReadonlyMap<string, IUnitLiveness>,
  issues: ISearchTuningLintIssue[],
): void {
  const unmarked = unmarkedDeclarations(probes);
  for (const p of probes) {
    const r = p.resolution;
    const n = p.lists.length;
    const times = n > 1 ? ` (declared ${n} times)` : '';
    const didYouMean = r.suggestion ? ` Did you mean "${r.suggestion}"?` : '';
    // A marker the settle could not honour (round 13): another declaration of
    // the same missing key is unmarked. Said on the marked declaration.
    const ignoredMarker =
      p.marks.length > 0 && (unmarked.get(p.key)?.length ?? 0) > 0
        ? ` Its expectEmpty marker is not honoured: the key is also declared unmarked (${(unmarked.get(p.key) ?? []).join(', ')}) — mark every declaration, or drop the unmarked one.`
        : '';
    const base = {
      tuningId: p.tuningId,
      ...(p.sourceFile ? { source: p.sourceFile } : {}),
      key: p.key,
      status: r.status,
      targetId: r.id,
      occurrences: n,
      ...(r.referenceKind ? { referenceKind: r.referenceKind } : {}),
      ...(r.suggestion ? { suggestion: r.suggestion } : {}),
    };
    const unit = unitOf.get(p.key);
    if (unit?.state === UnitLivenessState.IntendedEmpty) {
      issues.push({ ...base, severity: 'info', code: 'target-intended-empty', message: `Search tuning "${p.tuningId}" boosts "${p.key}" — ${unit.message}` });
    } else if (r.status === SearchTuningKeyStatus.Missing) {
      issues.push({
        ...base,
        severity: 'warning',
        code: 'target-missing',
        message: `Search tuning "${p.tuningId}" boosts "${p.key}"${times}, but no ${r.referenceKind} "${r.id}" is registered, so the boost can never fire — ${DEAD_SELECTOR_CAUSES}.${didYouMean}${ignoredMarker}`,
      });
    } else if (r.status === SearchTuningKeyStatus.Unprefixed) {
      issues.push({
        ...base,
        severity: 'warning',
        code: 'key-unprefixed',
        message: `Search tuning "${p.tuningId}" boosts "${p.key}"${times}: boost keys are search-document ids (\`<kind>:<id>\`), so a bare id never matches a document and the boost never fires.${didYouMean || (r.reason ? ` (${r.reason})` : '')}`,
      });
    } else if (r.status === SearchTuningKeyStatus.UnknownKind) {
      issues.push({
        ...base,
        // The KEY is what is wrong — its right-hand id names nothing yet.
        targetId: p.key,
        severity: 'warning',
        code: 'key-unknown-kind',
        message: `Search tuning "${p.tuningId}" boosts "${p.key}"${times}: ${r.reason ?? 'unknown document kind'}, so the boost never fires.${didYouMean}`,
      });
    }
    if (unit?.state === UnitLivenessState.WentLive && p.marks.length > 0) {
      issues.push({ ...base, severity: 'info', code: 'expect-empty-went-live', message: `Search tuning "${p.tuningId}" boosts "${p.key}" — ${unit.message}` });
    }
    if (p.excludedKind !== undefined) {
      issues.push({
        ...base,
        severity: 'warning',
        code: 'boost-excluded-by-kind',
        message: `Search tuning "${p.tuningId}" boosts "${p.key}", a ${p.excludedKind} document, but its appliesToKinds [${(p.appliesToKinds ?? []).join(', ')}] excludes ${p.excludedKind}, so the boost never fires.`,
      });
    }
  }
}

/** The task-hint findings, and one observation per hint for THE settle (a dead hint is dead by shape). */
function lintTriggers(entries: readonly ISearchTuningEntry[], issues: ISearchTuningLintIssue[]): IUnitObservation[] {
  const observations: IUnitObservation[] = [];
  for (const e of entries) {
    const source = e.sourceFile ? { source: e.sourceFile } : {};
    const firstHintWith = new Map<string, number>();
    (e.taskHints ?? []).forEach((h, i) => {
      const tokens = h.whenTokens ?? [];
      const label = `${e.id} task hint #${i + 1}`;
      const unit = `${e.id}#${i + 1}`;
      // The declaration the finding is about (it names no id).
      const field = `taskHints[${i}].whenTokens`;
      if (tokens.length === 0) {
        observations.push({
          list: TASK_HINTS_LIST,
          unit,
          label: `${label} (no whenTokens)`,
          exists: false,
          live: false,
          cause: UnitDeadCause.Defect,
          deadReason: 'declares no whenTokens, so it never applies',
        });
        issues.push({
          severity: 'warning',
          code: 'unreachable-trigger',
          tuningId: e.id,
          ...source,
          field,
          trigger: [],
          message: `Search tuning "${e.id}" task hint #${i + 1} declares no whenTokens, so it never applies.`,
        });
        return;
      }
      const unreachable = tokens.filter((t) => !isReachableTuningTrigger(t));
      for (const t of unreachable) {
        issues.push({
          severity: 'warning',
          code: 'unreachable-trigger',
          tuningId: e.id,
          ...source,
          field,
          trigger: tokens,
          message: `Search tuning "${e.id}" task hint #${i + 1} triggers on "${t}", which no query can produce (whitespace, a separator, or fewer than 2 characters), so the hint never applies.`,
        });
      }
      observations.push(
        unreachable.length > 0
          ? {
              list: TASK_HINTS_LIST,
              unit,
              label: `${label} [${tokens.join(', ')}]`,
              exists: false,
              live: false,
              cause: UnitDeadCause.Defect,
              deadReason: 'a whenToken no query can produce, so it never applies',
            }
          : { list: TASK_HINTS_LIST, unit, label, exists: true, live: true },
      );
      const signature = [...new Set(tokens)].sort().join(String.fromCharCode(0));
      const first = firstHintWith.get(signature);
      if (first === undefined) {
        firstHintWith.set(signature, i);
      } else {
        issues.push({
          severity: 'warning',
          code: 'duplicate-trigger',
          tuningId: e.id,
          ...source,
          field,
          trigger: tokens,
          message: `Search tuning "${e.id}" task hints #${first + 1} and #${i + 1} trigger on the same tokens [${tokens.join(', ')}]: they always fire together and their boosts sum toward the ±${SEARCH_TUNING_TOTAL_CAP} cap. Merge them.`,
        });
      }
    });
  }
  return observations;
}

function lintVocabulary(entries: readonly ISearchTuningEntry[], issues: ISearchTuningLintIssue[]): void {
  const suggest = (value: string, pool: readonly string[]): { suggestion?: string } => {
    const near = nearestIds(value, pool, 1)[0];
    return near ? { suggestion: near.id } : {};
  };
  for (const e of entries) {
    const source = e.sourceFile ? { source: e.sourceFile } : {};
    for (const kind of e.appliesToKinds ?? []) {
      if (SEARCH_KINDS.includes(kind)) continue;
      issues.push({
        severity: 'warning',
        code: 'unknown-kind',
        tuningId: e.id,
        ...source,
        field: 'appliesToKinds',
        ...suggest(kind, SEARCH_KINDS),
        message: `Search tuning "${e.id}" appliesToKinds names "${kind}", which is not a search kind (${SEARCH_KINDS.join(', ')}), so it admits no document.`,
      });
    }
    // One issue per kind name; `field` names the first task hint declaring it.
    const boostKinds = new Map<string, number>();
    (e.taskHints ?? []).forEach((h, i) => {
      for (const k of Object.keys(h.boostKinds ?? {})) if (!boostKinds.has(k)) boostKinds.set(k, i);
    });
    for (const [kind, hint] of boostKinds) {
      if (SEARCH_KINDS.includes(kind)) continue;
      issues.push({
        severity: 'warning',
        code: 'unknown-kind',
        tuningId: e.id,
        ...source,
        field: `taskHints[${hint}].boostKinds`,
        ...suggest(kind, SEARCH_KINDS),
        message: `Search tuning "${e.id}" taskHints boostKinds names "${kind}", which is not a search kind, so the boost never fires.`,
      });
    }
    for (const src of Object.keys(e.boostSources ?? {})) {
      if (SEARCH_SOURCES.includes(src)) continue;
      issues.push({
        severity: 'warning',
        code: 'unknown-source',
        tuningId: e.id,
        ...source,
        field: 'boostSources',
        ...suggest(src, SEARCH_SOURCES),
        message: `Search tuning "${e.id}" boostSources names "${src}", which is not a search source (${SEARCH_SOURCES.join(', ')}), so the boost never fires.`,
      });
    }
  }
}

/**
 * The total cap, made visible. A cheap worst case (every reachable task hint
 * firing at once) finds the candidate documents; each is then re-scored under
 * the queries that can REALLY happen together — no tokens (ambient boosts
 * only) and each task hint's own trigger set — so a document boosted by
 * mutually exclusive triggers (`java` / `python` / `go`) is not flagged.
 */
function lintCap(
  inspection: ISharkcraftInspection,
  entries: readonly ISearchTuningEntry[],
  issues: ISearchTuningLintIssue[],
): void {
  const triggerSets: string[][] = [[]];
  const everything = new Set<string>();
  for (const e of entries) {
    for (const h of e.taskHints ?? []) {
      const tokens = (h.whenTokens ?? []).map((t) => t.toLowerCase());
      if (tokens.length === 0 || !tokens.every((t) => isReachableTuningTrigger(t))) continue;
      triggerSets.push(tokens);
      for (const t of tokens) everything.add(t);
    }
  }
  const worstCase = [...everything];
  let reported = 0;
  let more = 0;
  for (const doc of buildSearchIndex(inspection)) {
    const subject = { id: doc.id, kind: doc.kind, ...(doc.tags ? { tags: doc.tags } : {}), source: doc.source };
    if (!tuningBoostFor(subject, worstCase, entries).capped) continue;
    let worst: { raw: number; applied: number; tokens: string[]; contributors: string[] } | undefined;
    for (const tokens of triggerSets) {
      const boost = tuningBoostFor(subject, tokens, entries);
      if (!boost.capped) continue;
      if (worst && Math.abs(boost.capped.raw) <= Math.abs(worst.raw)) continue;
      const contributors = [
        ...new Set((boost.composition ?? []).flatMap((c) => c.contributors.map((x) => x.tuningId))),
      ].sort();
      worst = { raw: boost.capped.raw, applied: boost.capped.applied, tokens, contributors };
    }
    if (!worst) continue;
    if (reported >= CAP_DISCARD_ISSUE_CAP) {
      more += 1;
      continue;
    }
    reported += 1;
    const discarded = Math.abs(worst.raw - worst.applied);
    const query = worst.tokens.length > 0 ? `a query containing [${worst.tokens.join(', ')}]` : 'every query';
    // The document EXISTS (the index built it): name it in its registry when
    // its prefix has one, so no consumer labels it an unknown id.
    const ref = searchDocumentReference(doc.id);
    issues.push({
      severity: 'info',
      code: 'cap-discards',
      tuningId: worst.contributors.join('+') || '(combined)',
      docId: doc.id,
      ...(ref ? { referenceKind: ref.referenceKind, targetId: ref.id } : {}),
      discarded,
      message: `Tuning on "${doc.id}" composes to ${signed(worst.raw)} for ${query}; the ±${SEARCH_TUNING_TOTAL_CAP} total cap discards ${discarded} (from ${worst.contributors.join(', ')}).`,
    });
  }
  if (more > 0) {
    issues.push({
      severity: 'info',
      code: 'cap-discards',
      tuningId: '(combined)',
      moreDocuments: more,
      message: `… and ${more} more document(s) whose tuning exceeds the ±${SEARCH_TUNING_TOTAL_CAP} total cap.`,
    });
  }
}

/**
 * Lint every loaded search-tuning entry. Loads the tuning and warms the
 * reference registries itself (a warm without a resolver keeps the command
 * resolver the CLI already injected).
 */
export async function lintSearchTuning(inspection: ISharkcraftInspection): Promise<ISearchTuningLintReport> {
  const { entries } = await loadSearchTuning(inspection);
  await warmReferenceRegistries(inspection);
  const keyProbes = searchTuningKeyProbes(inspection, entries);
  const keys = settleKeys(keyProbes);
  const issues: ISearchTuningLintIssue[] = [];
  lintKeys(keyProbes, keys.unitOf, issues);
  const hints = settleUnitLiveness({
    subject: COVERAGE_SUBJECT,
    unitLabel: 'task hints',
    weight: UnitDeadWeight.Coverage,
    observations: lintTriggers(entries, issues),
    marks: [],
    deadSummary: 'can never apply (a whenToken no query produces, or none at all)',
  });
  lintVocabulary(entries, issues);
  lintCap(inspection, entries, issues);

  const probes = { probed: 0, resolved: 0, missing: 0, unprefixed: 0, unknownKind: 0, unverified: 0 };
  for (const u of keys.settled.units) {
    const status = keyProbes.find((p) => p.key === u.unit)?.resolution.status;
    probes.probed += 1;
    if (status === SearchTuningKeyStatus.Resolved) probes.resolved += 1;
    else if (status === SearchTuningKeyStatus.Missing) probes.missing += 1;
    else if (status === SearchTuningKeyStatus.Unprefixed) probes.unprefixed += 1;
    else if (status === SearchTuningKeyStatus.UnknownKind) probes.unknownKind += 1;
    else probes.unverified += 1;
  }
  return {
    entries: entries.length,
    issues,
    probes,
    coverage: [...keys.settled.coverage, ...hints.coverage],
    deadUnits: [
      ...keys.settled.dead.map((u) => `search-tuning key ${u.label}`),
      ...hints.dead.map((u) => `search-tuning ${u.label}`),
    ],
    liveness: [keys.settled, hints],
    keyProbes,
  };
}
