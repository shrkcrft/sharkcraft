import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import { importModuleViaLoader } from '@shrkcrft/core';
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
}

const CACHE = new Map<string, ICacheEntry>();

interface IPolicyModule {
  default?: readonly { id?: string }[];
  policyChecks?: readonly { id?: string }[];
}

async function idsFrom(file: string, namespace: (id: string) => string): Promise<string[]> {
  try {
    const mod = (await importModuleViaLoader(file)) as IPolicyModule;
    const decls = mod.default ?? mod.policyChecks ?? [];
    return decls
      .filter((d) => typeof d?.id === 'string')
      .flatMap((d) => [d.id as string, namespace(d.id as string)]);
  } catch {
    // A policy file that will not load is `evaluatePolicy`'s problem to report
    // (it emits a load-failed check). Listing must not turn that into a crash.
    return [];
  }
}

/** Load every declared policy id — local files first, then pack contributions. */
export async function loadPolicyIds(inspection: ISharkcraftInspection): Promise<readonly string[]> {
  const validPacks = inspection.packs?.validPacks ?? [];
  const cacheKey = `${inspection.projectRoot}:${validPacks
    .map((p) => p.packageName + '@' + p.packageVersion)
    .join(',')}`;
  const cached = CACHE.get(inspection.projectRoot);
  if (cached && cached.cacheKey === cacheKey) return cached.list;

  const out: string[] = [];
  const cfg = inspection.config as { localPolicyFiles?: readonly string[] } | null;
  for (const rel of cfg?.localPolicyFiles ?? ['sharkcraft/policies.ts']) {
    const full = nodePath.isAbsolute(rel) ? rel : nodePath.join(inspection.projectRoot, rel);
    if (!existsSync(full)) continue;
    out.push(...(await idsFrom(full, (id) => `local:${id}`)));
  }
  for (const pack of validPacks) {
    const contributions = pack.manifest?.contributions as
      | { policyCheckFiles?: readonly string[] }
      | undefined;
    if (!pack.packageRoot) continue;
    for (const rel of contributions?.policyCheckFiles ?? []) {
      const full = nodePath.resolve(pack.packageRoot, rel);
      if (!existsSync(full)) continue;
      out.push(...(await idsFrom(full, (id) => `pack:${pack.packageName}:${id}`)));
    }
  }

  CACHE.set(inspection.projectRoot, { cacheKey, list: out });
  return out;
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
