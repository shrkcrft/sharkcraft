import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import type {
  IConstructFacetInput,
  IConstructFacetValue,
  IConstructInput,
} from '@shrkcrft/plugin-api';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import {
  importModuleViaLoader,
  readContributionExport,
  RejectionCause,
  type IContributionExport,
  type IRejectedEntry,
} from '@shrkcrft/core';
import type { IContributionFileIssue } from './i-contribution-file-issue.ts';

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
  facets: { readonly id: string; readonly constructId: string; readonly file: string; readonly packageName?: string }[];
  issues: IContributionFileIssue[];
  rejected: IRejectedEntry[];
  facetIssues: IContributionFileIssue[];
  facetRejected: IRejectedEntry[];
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

async function importList(file: string): Promise<IContributionExport> {
  return readContributionExport(await importModuleViaLoader(file), { namedKeys: ['constructs'] });
}

function firstLine(s: string): string {
  return (s.split('\n')[0] ?? s).trim();
}

/**
 * THE construct acceptance predicate (round 12, 12.1 / 12.1d): a non-empty
 * string `id` and a string `type` — `[]` means accepted. An id-less construct
 * used to be dropped silently, and one without `type` was ACCEPTED and then
 * crashed `constructs list` (`c.type.padEnd`).
 */
export function constructRejectionReasons(raw: unknown): readonly string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['(entry): must be an object'];
  const c = raw as Record<string, unknown>;
  const out: string[] = [];
  if (typeof c.id !== 'string' || c.id.length === 0) out.push('id: must be a non-empty string');
  if (typeof c.type !== 'string' || c.type.length === 0) out.push('type: must be a non-empty string');
  return out;
}

/**
 * THE construct-facet SHAPE predicate: `id`, `constructId`, `kind`, `value`,
 * each a string — `[]` means the shape is accepted. (A well-shaped facet whose
 * `constructId` names no loaded construct is refused at fold time.)
 */
export function constructFacetRejectionReasons(raw: unknown): readonly string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['(entry): must be an object'];
  const f = raw as Record<string, unknown>;
  return (['id', 'constructId', 'kind', 'value'] as const)
    .filter((k) => typeof f[k] !== 'string')
    .map((k) => `${k}: must be a string`);
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
  // More construct files come from pack manifests (`constructFiles`, loaded
  // below; docs/constructs.md) — there is no local-config key for them; the
  // strict config schema rejects one, so a local read here could never run.
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
  // Same for facets: pack manifests carry `constructFacetFiles`; local config
  // has no such key.
  return out;
}

/**
 * Load every local and pack construct (and fold loose facets into them), with
 * what did not take effect: files that failed to import (they used to be
 * swallowed — `catch { /* ignore *\/ }` — so a broken `constructs.ts` read as a
 * smaller registry), and every declared construct / facet the loader refused
 * (round 12, 12.1).
 */
export async function loadConstructsWithIssues(inspection: ISharkcraftInspection): Promise<{
  readonly constructs: readonly IConstruct[];
  /** Every facet folded into a construct, attributed to its file. */
  readonly facets: readonly {
    readonly id: string;
    readonly constructId: string;
    readonly file: string;
    readonly packageName?: string;
  }[];
  /** Construct files that failed to import / are missing. */
  readonly issues: readonly IContributionFileIssue[];
  /** Every declared construct the loader refused. */
  readonly rejected: readonly IRejectedEntry[];
  /** Facet files that failed to import / are missing. */
  readonly facetIssues: readonly IContributionFileIssue[];
  /** Every declared facet the loader refused (malformed, or its construct is not loaded). */
  readonly facetRejected: readonly IRejectedEntry[];
}> {
  const cacheKey = `${inspection.projectRoot}:${inspection.packs.validPacks
    .map((p) => p.packageName + '@' + p.packageVersion)
    .join(',')}`;
  const cached = CACHE.get(inspection.projectRoot);
  if (cached && cached.cacheKey === cacheKey) {
    return {
      constructs: cached.list,
      facets: cached.facets,
      issues: cached.issues,
      rejected: cached.rejected,
      facetIssues: cached.facetIssues,
      facetRejected: cached.facetRejected,
    };
  }

  const out: IConstruct[] = [];
  const constructIssues: IContributionFileIssue[] = [];
  const constructRejected: IRejectedEntry[] = [];
  const facetIssues: IContributionFileIssue[] = [];
  const facetRejected: IRejectedEntry[] = [];
  // Construct files and facet files are two contribution kinds: each keeps its own issues / refusals.
  let issues = constructIssues;
  let rejected = constructRejected;
  const rel = (file: string): string => nodePath.relative(inspection.projectRoot, file) || file;
  const load = async (file: string, packageName?: string): Promise<IContributionExport | null> => {
    try {
      return await importList(file);
    } catch (e) {
      issues.push({
        severity: 'warning',
        code: 'load-failed',
        message: `${packageName ? `Pack ${packageName} (${rel(file)})` : `Failed to load ${rel(file)}`}: ${firstLine((e as Error).message ?? String(e))}`,
        source: file,
        ...(packageName ? { packageName } : {}),
      });
      return null;
    }
  };
  const reject = (
    exp: IContributionExport,
    file: string,
    i: number,
    raw: unknown,
    reasons: readonly string[],
    cause: RejectionCause = RejectionCause.Invalid,
  ): void => {
    const id = raw && typeof raw === 'object' ? (raw as { id?: unknown }).id : undefined;
    rejected.push({
      file,
      index: exp.single ? -1 : i,
      ...(exp.exportName ? { exportName: exp.exportName } : {}),
      ...(typeof id === 'string' && id.length > 0 ? { entryId: id } : {}),
      reasons,
      cause,
    });
  };
  const ingestConstructs = (
    exp: IContributionExport,
    file: string,
    origin: Pick<IConstruct, 'source' | 'packageName' | 'sourceFile'>,
  ): void => {
    exp.items.forEach((c, i) => {
      const reasons = constructRejectionReasons(c);
      if (reasons.length > 0) {
        reject(exp, file, i, c, reasons);
        return;
      }
      out.push({ ...(c as IConstructInput), ...origin });
    });
  };

  // Local definitions.
  for (const file of localConstructFiles(inspection)) {
    const exp = await load(file);
    if (exp) ingestConstructs(exp, file, { source: 'local', sourceFile: rel(file) });
  }
  // Standalone facet files (folded into matching constructs).
  const looseFacets: {
    readonly facet: IConstructFacetInput;
    readonly exp: IContributionExport;
    readonly file: string;
    readonly index: number;
    readonly packageName?: string;
  }[] = [];
  const ingestFacets = (exp: IContributionExport, file: string, packageName?: string): void => {
    exp.items.forEach((f, i) => {
      const reasons = constructFacetRejectionReasons(f);
      if (reasons.length > 0) {
        reject(exp, file, i, f, reasons);
        return;
      }
      looseFacets.push({ facet: f as IConstructFacetInput, exp, file, index: i, ...(packageName ? { packageName } : {}) });
    });
  };
  issues = facetIssues;
  rejected = facetRejected;
  for (const file of localFacetFiles(inspection)) {
    const exp = await load(file);
    if (exp) ingestFacets(exp, file);
  }
  // Pack contributions.
  for (const pack of inspection.packs.validPacks ?? []) {
    const contributions = (pack.manifest?.contributions ?? {}) as {
      constructFiles?: readonly string[];
      constructFacetFiles?: readonly string[];
    };
    const packRoot = pack.packageRoot;
    if (!packRoot) continue;
    issues = constructIssues;
    rejected = constructRejected;
    for (const r of contributions.constructFiles ?? []) {
      const file = nodePath.resolve(packRoot, r);
      if (!existsSync(file)) {
        issues.push({
          severity: 'warning',
          code: 'missing-file',
          message: `Pack ${pack.packageName} declares ${r} but the file is missing.`,
          source: file,
          packageName: pack.packageName,
        });
        continue;
      }
      const exp = await load(file, pack.packageName);
      if (exp) ingestConstructs(exp, file, { source: 'pack', packageName: pack.packageName, sourceFile: r });
    }
    issues = facetIssues;
    rejected = facetRejected;
    for (const r of contributions.constructFacetFiles ?? []) {
      const file = nodePath.resolve(packRoot, r);
      if (!existsSync(file)) {
        issues.push({
          severity: 'warning',
          code: 'missing-file',
          message: `Pack ${pack.packageName} declares ${r} but the file is missing.`,
          source: file,
          packageName: pack.packageName,
        });
        continue;
      }
      const exp = await load(file, pack.packageName);
      if (exp) ingestFacets(exp, file, pack.packageName);
    }
  }
  // Fold loose facets into their target construct. A facet whose target is
  // not loaded never takes effect — refused, never silently dropped.
  issues = facetIssues;
  rejected = facetRejected;
  const facets: ICacheEntry['facets'] = [];
  for (const { facet: f, exp, file, index, packageName } of looseFacets) {
    const target = out.find((c) => c.id === f.constructId);
    if (!target) {
      reject(exp, file, index, f, [`constructId: no construct "${f.constructId}" is loaded`]);
      continue;
    }
    const byKind = (target.facets ?? {}) as Record<string, IConstructFacetValue[]>;
    const list = byKind[f.kind] ?? [];
    list.push({
      id: f.id,
      value: f.value,
      ...(f.description ? { description: f.description } : {}),
      ...(f.source ? { source: f.source } : {}),
      // Dropping it here would silently turn a declared id back into free text.
      ...(f.resolvesAs ? { resolvesAs: f.resolvesAs } : {}),
    });
    byKind[f.kind] = list;
    target.facets = byKind;
    facets.push({ id: f.id, constructId: f.constructId, file, ...(packageName ? { packageName } : {}) });
  }
  CACHE.set(inspection.projectRoot, {
    cacheKey,
    list: out,
    facets,
    issues: constructIssues,
    rejected: constructRejected,
    facetIssues,
    facetRejected,
  });
  return {
    constructs: out,
    facets,
    issues: constructIssues,
    rejected: constructRejected,
    facetIssues,
    facetRejected,
  };
}

export async function loadConstructs(
  inspection: ISharkcraftInspection,
): Promise<readonly IConstruct[]> {
  return (await loadConstructsWithIssues(inspection)).constructs;
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
