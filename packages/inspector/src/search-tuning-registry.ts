import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { ISearchTaskHint, ISearchTuning, ISearchTuningInput } from '@shrkcrft/plugin-api';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import {
  describeEntryValue,
  importModuleViaLoader,
  indexListPath,
  isMarkerObject,
  MARKABLE_UNIT_LISTS,
  MarkableUnitList,
  normalizeUnitMap,
  readContributionExport,
  RejectionCause,
  stampUnitMarks,
  unitProblemsOf,
  type IContributionExport,
  type IRejectedEntry,
  type IUnitMark,
} from '@shrkcrft/core';
import {
  isSearchDocumentPrefix,
  parseSearchDocumentId,
  SEARCH_DOCUMENT_PREFIXES,
  searchKindForPrefix,
} from './search-document-id.ts';

export const SEARCH_TUNING_SCHEMA = 'sharkcraft.search-tuning-registry/v1';

export interface ISearchTuningEntry extends ISearchTuning {
  source: 'local' | 'pack';
  packageName?: string;
  sourceFile?: string;
}

export interface ISearchTuningDoctorIssue {
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
  tuningId?: string;
  source?: string;
  /** `boost-clamped`: the boost key that was clamped. */
  key?: string;
  /**
   * `boost-clamped`: the map the key came from — `boostIds`, `boostTags`,
   * `boostSources`, `taskHints[<i>].boostIds|boostTags|boostKinds`. Only a
   * `boostIds` key is a search-document id; the rest are tag / source / kind
   * names, which no id registry lists.
   */
  field?: string;
  /** `boost-clamped`: the declared value. */
  original?: number;
  /** `boost-clamped`: the value applied. */
  clamped?: number;
}

interface ICacheEntry {
  cacheKey: string;
  entries: ISearchTuningEntry[];
  issues: ISearchTuningDoctorIssue[];
  rejected: IRejectedEntry[];
}

const CACHE = new Map<string, ICacheEntry>();

const MAX_BOOST = 5;

/** The per-boost clamp: every single boost value is clamped to ±this. */
export const SEARCH_TUNING_BOOST_CLAMP = MAX_BOOST;

/** The global cap: the total tuning delta on ONE document is clamped to ±this. */
export const SEARCH_TUNING_TOTAL_CAP = MAX_BOOST * 2;

async function importTunings(file: string): Promise<IContributionExport> {
  return readContributionExport(await importModuleViaLoader(file), { namedKeys: ['searchTuning'] });
}

/** THE list paths of the markable boost maps — the loader's marks and the lint's observations share them. */
export const SEARCH_TUNING_BOOST_IDS = MARKABLE_UNIT_LISTS[MarkableUnitList.SearchTuningBoostIds].listPath;
const TASK_HINT_BOOST_IDS = MARKABLE_UNIT_LISTS[MarkableUnitList.SearchTuningTaskHintBoostIds].listPath;

/** `taskHints[<i>].boostIds` — THE path a task hint's marks and observations are keyed by. */
export function searchTuningTaskHintBoostIdsPath(index: number): string {
  return indexListPath(TASK_HINT_BOOST_IDS, index);
}

/**
 * A markable boost map (`boostIds`, `taskHints[i].boostIds`): THE core parser's
 * problems (a value neither a number nor a `{ weight, expectEmpty: true }`
 * marker — alpha.30 silently clamped such a value to 0), plus a marker on a key
 * that can NEVER fire (no `<kind>:` search-document prefix, or a kind the
 * entry's `appliesToKinds` excludes): those are defects, and an expectEmpty
 * marker accepts only a target that does not exist yet.
 */
function markableBoostProblems(record: unknown, listPath: string, appliesToKinds: unknown): string[] {
  const n = normalizeUnitMap(record, listPath);
  if (!n.ok) return [...unitProblemsOf(n.error)];
  const out: string[] = [];
  for (const m of n.value.marks) {
    const at = `${listPath}[${JSON.stringify(m.unit)}]`;
    const parsed = parseSearchDocumentId(m.unit);
    if (!parsed || !isSearchDocumentPrefix(parsed.prefix)) {
      out.push(
        `${at}: an expectEmpty marker on a key that can never fire — a boost key is a search-document id \`<kind>:<id>\` (${SEARCH_DOCUMENT_PREFIXES.join(', ')}); fix the key (a marker accepts only a target that does not exist yet)`,
      );
      continue;
    }
    const kind = searchKindForPrefix(parsed.prefix) ?? parsed.prefix;
    if (Array.isArray(appliesToKinds) && !appliesToKinds.includes(kind)) {
      out.push(
        `${at}: an expectEmpty marker on a ${kind} key its entry's appliesToKinds [${appliesToKinds.join(', ')}] excludes, so the boost can never fire — fix the key or appliesToKinds`,
      );
    }
  }
  return out;
}

/** A plain boost map (`boostTags`, `boostSources`, `taskHints[i].boostTags|boostKinds`): numbers only. */
function plainBoostProblems(record: unknown, field: string): string[] {
  if (!isMarkerObject(record)) return [`${field}: must be a map of name → number (got ${describeEntryValue(record)})`];
  const out: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'number') continue;
    out.push(
      `${field}[${JSON.stringify(key)}]: must be a number (got ${describeEntryValue(value)})${
        isMarkerObject(value)
          ? ' — an expectEmpty marker is accepted only in boostIds and taskHints[].boostIds, whose keys name documents'
          : ''
      }`,
    );
  }
  return out;
}

/**
 * THE search-tuning acceptance predicate (round 12, 12.1; round 13): a
 * non-empty string `id`, and — so an older engine's silent clamp-to-0 can never
 * recur here — every boost value a number (or, in `boostIds` /
 * `taskHints[].boostIds`, a well-formed `{ weight, expectEmpty: true, reason? }`
 * marker on a key that can fire), `taskHints` an array of objects with string
 * `whenTokens`, and no authored `expectEmptyUnits` (the loader derives it).
 * `[]` means accepted.
 */
export function searchTuningRejectionReasons(raw: unknown): readonly string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['(entry): must be an object'];
  const o = raw as Record<string, unknown>;
  const out: string[] = [];
  if (!(typeof o.id === 'string' && o.id.length > 0)) out.push('id: must be a non-empty string');
  if ('expectEmptyUnits' in o) {
    out.push(`expectEmptyUnits: derived by the loader — mark the boost itself: boostIds: { '<kind>:<id>': { weight, expectEmpty: true } }`);
  }
  if (o.boostIds !== undefined) out.push(...markableBoostProblems(o.boostIds, SEARCH_TUNING_BOOST_IDS, o.appliesToKinds));
  for (const field of ['boostTags', 'boostSources'] as const) {
    if (o[field] !== undefined) out.push(...plainBoostProblems(o[field], field));
  }
  if (o.taskHints !== undefined) {
    if (!Array.isArray(o.taskHints)) {
      out.push(`taskHints: must be an array (got ${describeEntryValue(o.taskHints)})`);
    } else {
      o.taskHints.forEach((h: unknown, i: number) => {
        if (!isMarkerObject(h)) {
          out.push(`taskHints[${i}]: must be an object (got ${describeEntryValue(h)})`);
          return;
        }
        const tokens = h['whenTokens'];
        if (tokens !== undefined && (!Array.isArray(tokens) || tokens.some((t) => typeof t !== 'string'))) {
          out.push(`taskHints[${i}].whenTokens: must be an array of strings (got ${describeEntryValue(tokens)})`);
        }
        if (h['boostIds'] !== undefined) {
          out.push(...markableBoostProblems(h['boostIds'], searchTuningTaskHintBoostIdsPath(i), o.appliesToKinds));
        }
        for (const field of ['boostTags', 'boostKinds'] as const) {
          if (h[field] !== undefined) out.push(...plainBoostProblems(h[field], `taskHints[${i}].${field}`));
        }
      });
    }
  }
  return out;
}

function localTuningFiles(inspection: ISharkcraftInspection): string[] {
  const out: string[] = [];
  const dir = inspection.sharkcraftDir;
  if (!dir) return [];
  for (const f of ['search-tuning.ts', 'search-tuning/index.ts']) {
    const full = nodePath.join(dir, f);
    if (existsSync(full)) out.push(full);
  }
  // More tuning files come from pack manifests (`contributions.searchTuningFiles`,
  // loaded below; docs/search-tuning.md) — there is no local-config key for
  // them; the strict config schema rejects one, so a local read could never run.
  return out;
}

function clampBoost(value: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0;
  if (value > MAX_BOOST) return MAX_BOOST;
  if (value < -MAX_BOOST) return -MAX_BOOST;
  return value;
}

function sanitize(
  input: unknown,
  source: ISearchTuningEntry['source'],
  packageName: string | undefined,
  sourceFile: string,
  issues: ISearchTuningDoctorIssue[],
  rejected: IRejectedEntry[],
  at: Pick<IRejectedEntry, 'file' | 'index' | 'exportName'>,
): ISearchTuningEntry | null {
  const reasons = searchTuningRejectionReasons(input);
  if (reasons.length > 0) {
    // `search tuning doctor` keeps its `missing-id` warning; THE rejection
    // channel carries the structured record every other surface reads. An
    // entry refused for anything else (round 13: a boost value that is neither
    // a number nor a well-formed marker, a marker on a key that can never
    // fire) is an ERROR — it used to load with the value clamped to 0.
    const rawId = (input as { id?: unknown }).id;
    const entryId = typeof rawId === 'string' && rawId.length > 0 ? rawId : undefined;
    const where = `${sourceFile} (${at.exportName ?? 'default'}[${at.index}])`;
    issues.push(
      entryId === undefined
        ? { severity: 'warning', code: 'missing-id', message: `Tuning entry ${where} has no id; skipped.`, source: sourceFile }
        : {
            severity: 'error',
            code: 'invalid-entry',
            message: `Tuning entry "${entryId}" in ${where} was rejected — ${reasons.join('; ')}.`,
            tuningId: entryId,
            source: sourceFile,
          },
    );
    rejected.push({ ...at, ...(entryId !== undefined ? { entryId } : {}), reasons, cause: RejectionCause.Invalid });
    return null;
  }
  const raw = input as ISearchTuningInput;
  // THE value-form parser BEFORE the clamp (round 13): a `{ weight, expectEmpty }`
  // value keeps its weight and joins the ledger — it is never clamped to 0 again.
  const marks: IUnitMark[] = [];
  const idMaps: (Record<string, number> | undefined)[] = [];
  const idMapProblems: string[] = [];
  for (const [record, listPath] of [
    [raw.boostIds, SEARCH_TUNING_BOOST_IDS] as const,
    ...(raw.taskHints ?? []).map((h, i) => [h.boostIds, searchTuningTaskHintBoostIdsPath(i)] as const),
  ]) {
    if (record === undefined) {
      idMaps.push(undefined);
      continue;
    }
    const n = normalizeUnitMap(record, listPath);
    if (!n.ok) {
      idMapProblems.push(...unitProblemsOf(n.error));
      idMaps.push(undefined);
      continue;
    }
    marks.push(...n.value.marks);
    idMaps.push({ ...n.value.values });
  }
  if (idMapProblems.length > 0) {
    // Unreachable past the predicate; a refusal, never a silent clamp.
    issues.push({
      severity: 'error',
      code: 'invalid-entry',
      message: `Tuning entry "${raw.id}" in ${sourceFile} was rejected — ${idMapProblems.join('; ')}.`,
      tuningId: raw.id,
      source: sourceFile,
    });
    rejected.push({ ...at, entryId: raw.id, reasons: idMapProblems, cause: RejectionCause.Invalid });
    return null;
  }
  const out: ISearchTuningEntry = {
    id: raw.id,
    source,
    ...(packageName ? { packageName } : {}),
    sourceFile,
  };
  const stamped = stampUnitMarks(marks, packageName);
  if (stamped.length > 0) out.expectEmptyUnits = stamped;
  if (raw.appliesToKinds) out.appliesToKinds = raw.appliesToKinds;
  if (raw.mergeStrategy === 'sum' || raw.mergeStrategy === 'max') {
    out.mergeStrategy = raw.mergeStrategy;
  }
  // `field` names the map a clamped key came from, so a consumer can tell a
  // search-document id (`boostIds`) from a tag / source / kind name.
  const sanitizeRecord = (
    rec: Record<string, number> | undefined,
    field: string,
  ): Record<string, number> | undefined => {
    if (!rec) return undefined;
    const result: Record<string, number> = {};
    for (const [k, v] of Object.entries(rec)) {
      const clamped = clampBoost(v);
      if (clamped !== v) {
        issues.push({
          severity: 'info',
          code: 'boost-clamped',
          message: `Boost for "${k}" clamped to ${clamped} (was ${v}).`,
          tuningId: raw.id,
          source: sourceFile,
          key: k,
          field,
          original: v,
          clamped,
        });
      }
      result[k] = clamped;
    }
    return result;
  };
  const boostTags = sanitizeRecord(raw.boostTags, 'boostTags');
  if (boostTags) out.boostTags = boostTags;
  const boostIds = sanitizeRecord(idMaps[0], SEARCH_TUNING_BOOST_IDS);
  if (boostIds) out.boostIds = boostIds;
  const boostSources = sanitizeRecord(raw.boostSources, 'boostSources');
  if (boostSources) out.boostSources = boostSources;
  if (raw.taskHints) {
    out.taskHints = raw.taskHints.map((h, i): ISearchTaskHint => {
      const ids = idMaps[i + 1];
      return {
        ...(h.whenTokens ? { whenTokens: h.whenTokens.map((t) => t.toLowerCase()) } : {}),
        ...(h.boostTags ? { boostTags: sanitizeRecord(h.boostTags, `taskHints[${i}].boostTags`)! } : {}),
        ...(h.boostKinds ? { boostKinds: sanitizeRecord(h.boostKinds, `taskHints[${i}].boostKinds`)! } : {}),
        ...(ids ? { boostIds: sanitizeRecord(ids, searchTuningTaskHintBoostIdsPath(i))! } : {}),
      };
    });
  }
  return out;
}

export async function loadSearchTuning(
  inspection: ISharkcraftInspection,
): Promise<{
  entries: readonly ISearchTuningEntry[];
  issues: readonly ISearchTuningDoctorIssue[];
  /** Every declared tuning entry the loader refused (round 12, 12.1). */
  rejected: readonly IRejectedEntry[];
}> {
  const cacheKey = `${inspection.projectRoot}:${inspection.packs.validPacks
    .map((p) => p.packageName + '@' + p.packageVersion)
    .join(',')}`;
  const cached = CACHE.get(inspection.projectRoot);
  if (cached && cached.cacheKey === cacheKey) {
    return { entries: cached.entries, issues: cached.issues, rejected: cached.rejected };
  }
  const entries: ISearchTuningEntry[] = [];
  const issues: ISearchTuningDoctorIssue[] = [];
  const rejected: IRejectedEntry[] = [];
  const ingestAll = (
    exp: IContributionExport,
    file: string,
    source: ISearchTuningEntry['source'],
    packageName: string | undefined,
    sourceFile: string,
  ): void => {
    exp.items.forEach((raw, i) => {
      const ent = sanitize(raw, source, packageName, sourceFile, issues, rejected, {
        file,
        index: exp.single ? -1 : i,
        ...(exp.exportName ? { exportName: exp.exportName } : {}),
      });
      if (ent) entries.push(ent);
    });
  };

  for (const file of localTuningFiles(inspection)) {
    try {
      ingestAll(await importTunings(file), file, 'local', undefined, nodePath.relative(inspection.projectRoot, file));
    } catch (e) {
      issues.push({
        severity: 'warning',
        code: 'load-failed',
        message: `Failed to load ${file}: ${(e as Error).message}`,
        source: file,
      });
    }
  }
  for (const pack of inspection.packs.validPacks ?? []) {
    const contributions = (pack.manifest?.contributions ?? {}) as {
      searchTuningFiles?: readonly string[];
    };
    for (const rel of contributions.searchTuningFiles ?? []) {
      const file = nodePath.resolve(pack.packageRoot, rel);
      if (!existsSync(file)) {
        issues.push({
          severity: 'warning',
          code: 'missing-file',
          message: `Pack ${pack.packageName} declares tuning ${rel} but the file is missing.`,
          source: file,
        });
        continue;
      }
      try {
        ingestAll(await importTunings(file), file, 'pack', pack.packageName, rel);
      } catch (e) {
        issues.push({
          severity: 'warning',
          code: 'load-failed',
          message: `Pack ${pack.packageName} (${rel}): ${(e as Error).message}`,
          source: file,
        });
      }
    }
  }
  CACHE.set(inspection.projectRoot, { cacheKey, entries, issues, rejected });
  return { entries, issues, rejected };
}

export function listSearchTuning(inspection: ISharkcraftInspection): readonly ISearchTuningEntry[] {
  const cached = CACHE.get(inspection.projectRoot);
  return cached?.entries ?? [];
}

export function listSearchTuningIssues(inspection: ISharkcraftInspection): readonly ISearchTuningDoctorIssue[] {
  const cached = CACHE.get(inspection.projectRoot);
  return cached?.issues ?? [];
}

export interface ISearchTuningBoost {
  delta: number;
  reasons: string[];
  /** Per-key contributors and the merge strategy applied to each key. */
  composition?: readonly ISearchTuningComposition[];
  /**
   * Set when the global ±{@link SEARCH_TUNING_TOTAL_CAP} cap discarded part of
   * the composed delta (`raw` → `applied`). The cap used to apply silently
   * while the per-boost clamp emitted a diagnostic.
   */
  capped?: { readonly raw: number; readonly applied: number };
}

export interface ISearchTuningContribution {
  tuningId: string;
  value: number;
}

export interface ISearchTuningComposition {
  /** e.g. `tag:plugin`, `id:<pack>.plugin`, `source:<pack>`, `task-kind:rule`. */
  key: string;
  strategy: 'sum' | 'max';
  contributors: readonly ISearchTuningContribution[];
  /** Final value after the strategy is applied (before global cap). */
  combined: number;
}

interface IContributionBuffer {
  byKey: Map<string, ISearchTuningContribution[]>;
}

function pushContribution(
  buf: IContributionBuffer,
  key: string,
  tuningId: string,
  value: number,
): void {
  if (value === 0) return;
  let list = buf.byKey.get(key);
  if (!list) {
    list = [];
    buf.byKey.set(key, list);
  }
  list.push({ tuningId, value });
}

/** Compute the boost contribution for a single document. Returns the additive
 *  delta, the matching reasons, and the per-key composition (so explain
 *  reports can show "two tunings contributed +3 each but max strategy keeps
 *  only +3 instead of +6").
 *
 *  Merge strategy: when ANY contributor on a key declares `mergeStrategy:'max'`,
 *  the key uses max-by-absolute-value; otherwise it sums. The global ±10 cap
 *  applies after composition. */
export function tuningBoostFor(
  doc: { id: string; kind: string; tags?: readonly string[]; source: string },
  tokens: readonly string[],
  entries: readonly ISearchTuningEntry[],
): ISearchTuningBoost {
  const buf: IContributionBuffer = { byKey: new Map() };
  const strategyByKey = new Map<string, 'sum' | 'max'>();
  const setStrategy = (key: string, entry: ISearchTuningEntry): void => {
    if (entry.mergeStrategy === 'max') strategyByKey.set(key, 'max');
    else if (!strategyByKey.has(key)) strategyByKey.set(key, 'sum');
  };
  for (const e of entries) {
    if (e.appliesToKinds && !e.appliesToKinds.includes(doc.kind)) continue;
    if (e.boostTags && doc.tags) {
      for (const t of doc.tags) {
        const b = e.boostTags[t];
        if (typeof b === 'number' && b !== 0) {
          const key = `tag:${t}`;
          pushContribution(buf, key, e.id, b);
          setStrategy(key, e);
        }
      }
    }
    if (e.boostIds) {
      const b = e.boostIds[doc.id];
      if (typeof b === 'number' && b !== 0) {
        const key = `id:${doc.id}`;
        pushContribution(buf, key, e.id, b);
        setStrategy(key, e);
      }
    }
    if (e.boostSources) {
      const b = e.boostSources[doc.source];
      if (typeof b === 'number' && b !== 0) {
        const key = `source:${doc.source}`;
        pushContribution(buf, key, e.id, b);
        setStrategy(key, e);
      }
    }
    if (e.taskHints) {
      for (const h of e.taskHints) {
        if (!h.whenTokens || h.whenTokens.length === 0) continue;
        const queryMatches = h.whenTokens.every((wt) => tokens.includes(wt));
        if (!queryMatches) continue;
        if (h.boostTags && doc.tags) {
          for (const t of doc.tags) {
            const b = h.boostTags[t];
            if (typeof b === 'number' && b !== 0) {
              const key = `task-hint:tag:${t}`;
              pushContribution(buf, key, e.id, b);
              setStrategy(key, e);
            }
          }
        }
        if (h.boostKinds) {
          const b = h.boostKinds[doc.kind];
          if (typeof b === 'number' && b !== 0) {
            const key = `task-hint:kind:${doc.kind}`;
            pushContribution(buf, key, e.id, b);
            setStrategy(key, e);
          }
        }
        if (h.boostIds) {
          const b = h.boostIds[doc.id];
          if (typeof b === 'number' && b !== 0) {
            const key = `task-hint:id:${doc.id}`;
            pushContribution(buf, key, e.id, b);
            setStrategy(key, e);
          }
        }
      }
    }
  }
  // Compose per key.
  let delta = 0;
  const reasons: string[] = [];
  const composition: ISearchTuningComposition[] = [];
  for (const [key, contributors] of buf.byKey) {
    const strategy = strategyByKey.get(key) ?? 'sum';
    let combined = 0;
    if (strategy === 'max') {
      // Strongest absolute value wins; preserves sign.
      let pick = contributors[0]!;
      for (const c of contributors) {
        if (Math.abs(c.value) > Math.abs(pick.value)) pick = c;
      }
      combined = pick.value;
    } else {
      for (const c of contributors) combined += c.value;
    }
    delta += combined;
    composition.push({ key, strategy, contributors, combined });
    for (const c of contributors) {
      reasons.push(
        `tuning:${c.tuningId} ${key} ${c.value > 0 ? '+' : ''}${c.value}${
          contributors.length > 1 ? ' (strategy=' + strategy + ')' : ''
        }`,
      );
    }
  }
  // Global cap so tuning can't dominate the natural signal — reported, never
  // silent: the reason names what was discarded.
  const raw = delta;
  if (delta > SEARCH_TUNING_TOTAL_CAP) delta = SEARCH_TUNING_TOTAL_CAP;
  if (delta < -SEARCH_TUNING_TOTAL_CAP) delta = -SEARCH_TUNING_TOTAL_CAP;
  if (delta !== raw) {
    const signed = (n: number): string => `${n > 0 ? '+' : ''}${n}`;
    reasons.push(`tuning-cap: raw ${signed(raw)} -> ${signed(delta)}`);
    return { delta, reasons, composition, capped: { raw, applied: delta } };
  }
  return { delta, reasons, composition };
}
