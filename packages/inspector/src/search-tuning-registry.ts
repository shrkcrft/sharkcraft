import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { ISearchTuning } from '@shrkcrft/plugin-api';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import { importModuleViaLoader } from '@shrkcrft/core';

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
}

interface ICacheEntry {
  cacheKey: string;
  entries: ISearchTuningEntry[];
  issues: ISearchTuningDoctorIssue[];
}

const CACHE = new Map<string, ICacheEntry>();

const MAX_BOOST = 5;

async function importDefault<T>(file: string): Promise<readonly T[]> {
  const mod = (await importModuleViaLoader(file)) as {
    default?: readonly T[] | T;
    searchTuning?: readonly T[];
  };
  if (Array.isArray(mod.default)) return mod.default;
  if (mod.default && typeof mod.default === 'object') return [mod.default as T];
  if (Array.isArray(mod.searchTuning)) return mod.searchTuning as readonly T[];
  return [];
}

function localTuningFiles(inspection: ISharkcraftInspection): string[] {
  const out: string[] = [];
  const dir = inspection.sharkcraftDir;
  if (!dir) return [];
  for (const f of ['search-tuning.ts', 'search-tuning/index.ts']) {
    const full = nodePath.join(dir, f);
    if (existsSync(full)) out.push(full);
  }
  const cfg = inspection.config as { searchTuningFiles?: readonly string[] } | null;
  for (const rel of cfg?.searchTuningFiles ?? []) {
    out.push(nodePath.join(dir, rel));
  }
  return out;
}

function clampBoost(value: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0;
  if (value > MAX_BOOST) return MAX_BOOST;
  if (value < -MAX_BOOST) return -MAX_BOOST;
  return value;
}

function sanitize(
  raw: ISearchTuning,
  source: ISearchTuningEntry['source'],
  packageName: string | undefined,
  sourceFile: string,
  issues: ISearchTuningDoctorIssue[],
): ISearchTuningEntry | null {
  if (typeof raw.id !== 'string' || raw.id.length === 0) {
    issues.push({
      severity: 'warning',
      code: 'missing-id',
      message: 'Tuning entry has no id; skipped.',
      source: sourceFile,
    });
    return null;
  }
  const out: ISearchTuningEntry = {
    id: raw.id,
    source,
    ...(packageName ? { packageName } : {}),
    sourceFile,
  };
  if (raw.appliesToKinds) out.appliesToKinds = raw.appliesToKinds;
  if (raw.mergeStrategy === 'sum' || raw.mergeStrategy === 'max') {
    out.mergeStrategy = raw.mergeStrategy;
  }
  const sanitizeRecord = (rec: Record<string, number> | undefined): Record<string, number> | undefined => {
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
        });
      }
      result[k] = clamped;
    }
    return result;
  };
  const boostTags = sanitizeRecord(raw.boostTags);
  if (boostTags) out.boostTags = boostTags;
  const boostIds = sanitizeRecord(raw.boostIds);
  if (boostIds) out.boostIds = boostIds;
  const boostSources = sanitizeRecord(raw.boostSources);
  if (boostSources) out.boostSources = boostSources;
  if (raw.taskHints) {
    out.taskHints = raw.taskHints.map((h) => ({
      ...(h.whenTokens ? { whenTokens: h.whenTokens.map((t) => t.toLowerCase()) } : {}),
      ...(h.boostTags ? { boostTags: sanitizeRecord(h.boostTags)! } : {}),
      ...(h.boostKinds ? { boostKinds: sanitizeRecord(h.boostKinds)! } : {}),
      ...(h.boostIds ? { boostIds: sanitizeRecord(h.boostIds)! } : {}),
    }));
  }
  return out;
}

export async function loadSearchTuning(
  inspection: ISharkcraftInspection,
): Promise<{ entries: readonly ISearchTuningEntry[]; issues: readonly ISearchTuningDoctorIssue[] }> {
  const cacheKey = `${inspection.projectRoot}:${inspection.packs.validPacks
    .map((p) => p.packageName + '@' + p.packageVersion)
    .join(',')}`;
  const cached = CACHE.get(inspection.projectRoot);
  if (cached && cached.cacheKey === cacheKey) {
    return { entries: cached.entries, issues: cached.issues };
  }
  const entries: ISearchTuningEntry[] = [];
  const issues: ISearchTuningDoctorIssue[] = [];

  for (const file of localTuningFiles(inspection)) {
    try {
      const list = await importDefault<ISearchTuning>(file);
      for (const raw of list) {
        const ent = sanitize(raw, 'local', undefined, nodePath.relative(inspection.projectRoot, file), issues);
        if (ent) entries.push(ent);
      }
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
        const list = await importDefault<ISearchTuning>(file);
        for (const raw of list) {
          const ent = sanitize(raw, 'pack', pack.packageName, rel, issues);
          if (ent) entries.push(ent);
        }
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
  CACHE.set(inspection.projectRoot, { cacheKey, entries, issues });
  return { entries, issues };
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
  // Global cap so tuning can't dominate the natural signal.
  if (delta > MAX_BOOST * 2) delta = MAX_BOOST * 2;
  if (delta < -MAX_BOOST * 2) delta = -MAX_BOOST * 2;
  return { delta, reasons, composition };
}
