import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import type {
  IConstructFacetInput,
  IConstructFacetValue,
  IConstructInput,
} from '@shrkcrft/plugin-api';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import { importModuleViaLoader } from '@shrkcrft/core';

export const CONSTRUCT_REGISTRY_SCHEMA = 'sharkcraft.construct-registry/v1';

export interface IConstruct extends IConstructInput {
  source: 'local' | 'pack';
  packageName?: string;
  sourceFile?: string;
}

export interface IConstructFacet extends IConstructFacetInput {}

interface ICacheEntry {
  cacheKey: string;
  list: IConstruct[];
}

const CACHE = new Map<string, ICacheEntry>();

function readJsonOrEmpty(file: string): unknown {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

async function importDefault<T>(file: string): Promise<readonly T[]> {
  const mod = (await importModuleViaLoader(file)) as {
    default?: readonly T[] | T;
    constructs?: readonly T[];
    playbooks?: readonly T[];
  };
  const def = mod.default;
  if (Array.isArray(def)) return def as readonly T[];
  if (def && typeof def === 'object') return [def as T];
  if (Array.isArray(mod.constructs)) return mod.constructs as readonly T[];
  return [];
}

function localConstructFiles(inspection: ISharkcraftInspection): string[] {
  const out: string[] = [];
  const dir = inspection.sharkcraftDir;
  if (!dir) return [];
  const defaults = ['constructs.ts', 'constructs.js', 'constructs/index.ts'];
  for (const f of defaults) {
    const full = nodePath.join(dir, f);
    if (existsSync(full)) out.push(full);
  }
  const cfg = inspection.config as { constructFiles?: readonly string[] } | null;
  if (cfg?.constructFiles) {
    for (const rel of cfg.constructFiles) out.push(nodePath.join(dir, rel));
  }
  return out;
}

function localFacetFiles(inspection: ISharkcraftInspection): string[] {
  const out: string[] = [];
  const dir = inspection.sharkcraftDir;
  if (!dir) return [];
  const defaults = ['construct-facets.ts', 'construct-facets/index.ts'];
  for (const f of defaults) {
    const full = nodePath.join(dir, f);
    if (existsSync(full)) out.push(full);
  }
  const cfg = inspection.config as { constructFacetFiles?: readonly string[] } | null;
  if (cfg?.constructFacetFiles) {
    for (const rel of cfg.constructFacetFiles) out.push(nodePath.join(dir, rel));
  }
  return out;
}

export async function loadConstructs(
  inspection: ISharkcraftInspection,
): Promise<readonly IConstruct[]> {
  const cacheKey = `${inspection.projectRoot}:${inspection.packs.validPacks
    .map((p) => p.packageName + '@' + p.packageVersion)
    .join(',')}`;
  const cached = CACHE.get(inspection.projectRoot);
  if (cached && cached.cacheKey === cacheKey) return cached.list;

  const out: IConstruct[] = [];
  // Local definitions.
  for (const file of localConstructFiles(inspection)) {
    try {
      const list = await importDefault<IConstructInput>(file);
      for (const c of list) {
        if (!c?.id) continue;
        const entry: IConstruct = { ...c, source: 'local' };
        entry.sourceFile = nodePath.relative(inspection.projectRoot, file);
        out.push(entry);
      }
    } catch {
      /* ignore — packs are best-effort */
    }
  }
  // Standalone facet files (folded into matching constructs).
  const looseFacets: IConstructFacet[] = [];
  for (const file of localFacetFiles(inspection)) {
    try {
      const list = await importDefault<IConstructFacetInput>(file);
      for (const f of list) {
        looseFacets.push(f);
      }
    } catch {
      /* ignore */
    }
  }
  // Pack contributions.
  for (const pack of inspection.packs.validPacks ?? []) {
    const contributions = (pack.manifest?.contributions ?? {}) as {
      constructFiles?: readonly string[];
      constructFacetFiles?: readonly string[];
    };
    const packRoot = pack.packageRoot;
    if (!packRoot) continue;
    for (const rel of contributions.constructFiles ?? []) {
      const file = nodePath.resolve(packRoot, rel);
      if (!existsSync(file)) continue;
      try {
        const list = await importDefault<IConstructInput>(file);
        for (const c of list) {
          if (!c?.id) continue;
          out.push({
            ...c,
            source: 'pack',
            packageName: pack.packageName,
            sourceFile: rel,
          });
        }
      } catch {
        /* ignore */
      }
    }
    for (const rel of contributions.constructFacetFiles ?? []) {
      const file = nodePath.resolve(packRoot, rel);
      if (!existsSync(file)) continue;
      try {
        const list = await importDefault<IConstructFacetInput>(file);
        for (const f of list) looseFacets.push(f);
      } catch {
        /* ignore */
      }
    }
  }
  // Fold loose facets into their target construct.
  for (const f of looseFacets) {
    const target = out.find((c) => c.id === f.constructId);
    if (!target) continue;
    const facets = (target.facets ?? {}) as Record<string, IConstructFacetValue[]>;
    const list = facets[f.kind] ?? [];
    list.push({
      id: f.id,
      value: f.value,
      ...(f.description ? { description: f.description } : {}),
      ...(f.source ? { source: f.source } : {}),
    });
    facets[f.kind] = list;
    target.facets = facets;
  }
  CACHE.set(inspection.projectRoot, { cacheKey, list: out });
  return out;
}

/** Synchronous accessor — falls back to a snapshot cached from the last
 *  async load. Used by search-index which needs to be sync-friendly. */
export function listConstructs(inspection: ISharkcraftInspection): readonly IConstruct[] {
  const cached = CACHE.get(inspection.projectRoot);
  return cached?.list ?? [];
}

/** Pre-warm the cache so subsequent sync reads see a populated list. */
export async function warmConstructCache(inspection: ISharkcraftInspection): Promise<void> {
  await loadConstructs(inspection);
}

export interface IConstructTrace {
  construct: IConstruct;
  files: readonly string[];
  publicApi: readonly string[];
  events: readonly string[];
  tokens: readonly string[];
  commands: readonly string[];
  relatedKnowledge: readonly string[];
  relatedRules: readonly string[];
  relatedTemplates: readonly string[];
  relatedPipelines: readonly string[];
  facets: Record<string, readonly IConstructFacetValue[]>;
  warnings: readonly string[];
}

export function traceConstruct(construct: IConstruct): IConstructTrace {
  const warnings: string[] = [];
  if ((construct.publicApi ?? []).length === 0) {
    warnings.push('No publicApi entries declared — `shrk constructs api` will be empty.');
  }
  return {
    construct,
    files: construct.files ?? [],
    publicApi: construct.publicApi ?? [],
    events: construct.events ?? [],
    tokens: construct.tokens ?? [],
    commands: construct.commands ?? [],
    relatedKnowledge: construct.relatedKnowledge ?? [],
    relatedRules: construct.relatedRules ?? [],
    relatedTemplates: construct.relatedTemplates ?? [],
    relatedPipelines: construct.relatedPipelines ?? [],
    facets: (construct.facets ?? {}) as Record<string, readonly IConstructFacetValue[]>,
    warnings,
  };
}

void readJsonOrEmpty;
