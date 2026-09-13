import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  importModuleViaLoader,
  readContributionExport,
  RejectionCause,
  type IAssetReference,
  type IRejectedEntry,
} from '@shrkcrft/core';
import type { IContributionFileIssue } from './i-contribution-file-issue.ts';
import type { IPolicyDeclaration } from './policy-declaration.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

/**
 * The ids of every declared policy check, without running any of them.
 *
 * `evaluatePolicy` knows these ids, but only as a side effect of EXECUTING
 * each declaration against the tree — far too heavy for "does this id exist?",
 * and wrong to trigger from a doc linter. So the declarations are loaded and
 * their ids read, and nothing is run.
 *
 * Before this existed, "does policy X exist?" was answered by reading
 * `inspection.policyChecks` — a property nothing assigns. The answer was
 * therefore always "no", including for correct ids. A registry that cannot
 * list is a registry that will confidently reject valid input.
 */

/**
 * BOTH names of every check are listed.
 *
 * A policy has two legitimate ids: the bare one its author declared and cites
 * from a decision record or an agent test (`sharkcraft.mcp-read-only`), and the
 * namespaced one `evaluatePolicy` reports at runtime
 * (`local:sharkcraft.mcp-read-only`). Listing only the namespaced form makes
 * every reference in the repo read as unknown — which is precisely the
 * "confidently reject valid input" failure this registry was added to end.
 */
interface ICacheEntry {
  cacheKey: string;
  list: string[];
  /** The same load, kept whole — the staleness sweep reads their `references[]`. */
  declarations: IPolicyDeclaration[];
  /** Policy files that failed to import (round 12, 12.1c — they were swallowed to `[]`). */
  issues: IContributionFileIssue[];
  /** Every declared check the loader refused (round 12, 12.1). */
  rejected: IRejectedEntry[];
}

const CACHE = new Map<string, ICacheEntry>();

/**
 * THE policy-declaration acceptance predicate (round 12, 12.1): a non-empty
 * string `id` — `[]` means accepted. An id-less declaration used to be
 * filtered out with no signal. (A declaration's `evaluate` is the policy
 * engine's to run; an id alone is enough to be referenced.)
 */
export function policyCheckRejectionReasons(raw: unknown): readonly string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['(entry): must be an object'];
  const id = (raw as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? [] : ['id: must be a non-empty string'];
}

async function declarationsFrom(
  file: string,
  source: 'local' | 'pack',
  namespace: (id: string) => string,
  sink: Pick<ICacheEntry, 'declarations' | 'issues' | 'rejected'>,
  label: string,
  packageName?: string,
): Promise<string[]> {
  let exp;
  try {
    exp = readContributionExport(await importModuleViaLoader(file), {
      namedKeys: ['policyChecks'],
      singleObject: false,
    });
  } catch (e) {
    // A policy file that will not load must not crash listing — and must not
    // vanish either: it is a load failure THE failure map reports.
    sink.issues.push({
      severity: 'warning',
      code: 'load-failed',
      message: `${label}: ${((e as Error).message ?? String(e)).split('\n')[0]!.trim()}`,
      source: file,
      ...(packageName ? { packageName } : {}),
    });
    return [];
  }
  const ids: string[] = [];
  exp.items.forEach((d, index) => {
    const reasons = policyCheckRejectionReasons(d);
    if (reasons.length > 0) {
      sink.rejected.push({
        file,
        index,
        ...(exp.exportName ? { exportName: exp.exportName } : {}),
        reasons,
        cause: RejectionCause.Invalid,
      });
      return;
    }
    const decl = d as { id: string; references?: readonly IAssetReference[] };
    sink.declarations.push({
      id: decl.id,
      qualifiedId: namespace(decl.id),
      source,
      sourceFile: file,
      ...(Array.isArray(decl.references) ? { references: decl.references } : {}),
    });
    ids.push(decl.id, namespace(decl.id));
  });
  return ids;
}

/** One load of every declared policy check — local files first, then pack contributions — cached per project. */
async function loadPolicyCache(inspection: ISharkcraftInspection): Promise<ICacheEntry> {
  const validPacks = inspection.packs?.validPacks ?? [];
  const cacheKey = `${inspection.projectRoot}:${validPacks
    .map((p) => p.packageName + '@' + p.packageVersion)
    .join(',')}`;
  const cached = CACHE.get(inspection.projectRoot);
  if (cached && cached.cacheKey === cacheKey) return cached;

  const entry: ICacheEntry = { cacheKey, list: [], declarations: [], issues: [], rejected: [] };
  // The local policy file is the policy engine's own default. `localPolicyFiles`
  // is an engine INPUT (`evaluatePolicy`), not a config key — the strict config
  // schema rejects it — so the config read that used to sit here was dead.
  for (const rel of ['sharkcraft/policies.ts']) {
    const full = nodePath.isAbsolute(rel) ? rel : nodePath.join(inspection.projectRoot, rel);
    if (!existsSync(full)) continue;
    entry.list.push(...(await declarationsFrom(full, 'local', (id) => `local:${id}`, entry, `Failed to load ${rel}`)));
  }
  for (const pack of validPacks) {
    const contributions = pack.manifest?.contributions as
      | { policyCheckFiles?: readonly string[] }
      | undefined;
    if (!pack.packageRoot) continue;
    for (const rel of contributions?.policyCheckFiles ?? []) {
      const full = nodePath.resolve(pack.packageRoot, rel);
      if (!existsSync(full)) continue;
      entry.list.push(
        ...(await declarationsFrom(
          full,
          'pack',
          (id) => `pack:${pack.packageName}:${id}`,
          entry,
          `Pack ${pack.packageName} (${rel})`,
          pack.packageName,
        )),
      );
    }
  }

  CACHE.set(inspection.projectRoot, entry);
  return entry;
}

/** Load every declared policy id — local files first, then pack contributions. */
export async function loadPolicyIds(inspection: ISharkcraftInspection): Promise<readonly string[]> {
  return (await loadPolicyCache(inspection)).list;
}

/**
 * The declared policy checks WITH what did not take effect (round 12, 12.1):
 * files that failed to import and every declaration the loader refused — from
 * the same one load {@link loadPolicyIds} reads.
 */
export async function loadPolicyDeclarationsWithIssues(inspection: ISharkcraftInspection): Promise<{
  readonly declarations: readonly IPolicyDeclaration[];
  readonly issues: readonly IContributionFileIssue[];
  readonly rejected: readonly IRejectedEntry[];
}> {
  const c = await loadPolicyCache(inspection);
  return { declarations: c.declarations, issues: c.issues, rejected: c.rejected };
}

/**
 * The declared policy checks (id, source, `references[]`) from the SAME cache
 * {@link warmPolicyCache} fills — one reader of the declarations. Returns `[]`
 * until the cache is warm; the staleness sweep reports that as "not in sweep",
 * never as "no policies".
 */
export function listPolicyDeclarations(
  inspection: ISharkcraftInspection,
): readonly IPolicyDeclaration[] {
  return CACHE.get(inspection.projectRoot)?.declarations ?? [];
}

/**
 * The cached policy ids.
 *
 * Synchronous by design, so sync consumers (the reference resolver, the query
 * ranker) can use it. Returns `[]` until {@link warmPolicyCache} has run — the
 * reference registry's empty-kind guard is what stops that reading as "no such
 * policy" for every id.
 */
export function listPolicyIds(inspection: ISharkcraftInspection): readonly string[] {
  return CACHE.get(inspection.projectRoot)?.list ?? [];
}

/** Pre-warm the cache so subsequent sync reads see a populated list. */
export async function warmPolicyCache(inspection: ISharkcraftInspection): Promise<void> {
  await loadPolicyIds(inspection);
}
