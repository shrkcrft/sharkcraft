/**
 * THE helper catalog — built-in helpers ∪ pack/local-contributed helpers.
 *
 * `helper list|get|plan` used to read only the built-in `HELPERS` (which ships
 * empty), while the id resolver, universal search and the MCP pack-helper tools
 * read the pack loader — two authorities answering "which helpers exist", so
 * the self-config doctor saw a helper that `helper get` called unknown. Every
 * helper surface now reads this one catalog; `warmReferenceRegistries` derives
 * the resolver's `helper` ids from it, so list ≡ resolve by construction.
 */
import * as nodePath from 'node:path';
import { RejectionCause, type IRejectedEntry } from '@shrkcrft/core';
import { HELPERS } from './helper-registry.ts';
import type { IHelperView } from './helper-view.ts';
import { loadPackHelpers, type IPackHelperDoctorIssue } from './pack-helper-registry.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export interface IHelperCatalog {
  /** Every helper, deduped by id: built-ins first, then local, then pack (loader order). */
  readonly entries: readonly IHelperView[];
  /** load-failed / missing-file / invalid-helper / duplicate-id / helper-warning issues. */
  readonly issues: readonly IPackHelperDoctorIssue[];
  /** Every helper FILE considered (local `helpers.ts` + pack `helperFiles[]`) and whether it loaded. */
  readonly files: readonly { readonly file: string; readonly status: 'loaded' | 'failed' | 'missing' }[];
  /**
   * Every declared helper that did not make the catalog (round 12, 12.1): the
   * loader's refusals plus a contributed helper shadowed by a built-in id.
   */
  readonly rejected: readonly IRejectedEntry[];
}

/** Build the catalog. One pack-helper load per call (it returns entries AND issues). */
export async function listAllHelpers(inspection: ISharkcraftInspection): Promise<IHelperCatalog> {
  const entries: IHelperView[] = [];
  const issues: IPackHelperDoctorIssue[] = [];
  const seen = new Set<string>();
  for (const h of HELPERS) {
    seen.add(h.id);
    entries.push({
      id: h.id,
      title: h.id,
      description: h.description,
      source: 'builtin',
      destructive: h.destructive,
      requiresHumanReview: h.requiresHumanReview,
      requiresProfile: h.requiresProfile === true,
      outputKind: 'plan',
      variables: h.variables.map((v) => ({ name: v.name, required: v.required, description: v.description })),
      operations: [],
      manualChecklist: [],
      tags: [],
    });
  }
  const loaded = await loadPackHelpers(inspection);
  issues.push(...loaded.issues);
  const rejected: IRejectedEntry[] = [...loaded.rejected];
  for (const e of loaded.entries) {
    const h = e.helper;
    if (seen.has(h.id)) {
      issues.push({
        severity: 'error',
        code: 'duplicate-id',
        message: `Helper "${h.id}" from ${e.sourceFile} duplicates a built-in helper — the built-in wins.`,
        helperId: h.id,
        source: e.sourceFile,
      });
      const packRoot = e.packageName
        ? inspection.packs.validPacks.find((p) => p.packageName === e.packageName)?.packageRoot
        : undefined;
      rejected.push({
        file: nodePath.resolve(packRoot ?? inspection.projectRoot, e.sourceFile),
        index: -1,
        entryId: h.id,
        reasons: [`id: "${h.id}" is a built-in helper — the built-in wins`],
        cause: RejectionCause.DuplicateId,
      });
      continue;
    }
    seen.add(h.id);
    entries.push({
      id: h.id,
      title: h.title,
      description: h.description,
      source: e.source,
      ...(e.packageName ? { packageName: e.packageName } : {}),
      sourceFile: e.sourceFile,
      destructive: h.safety.destructivePotential === true,
      requiresHumanReview: h.safety.requiresHumanReview === true,
      requiresProfile: h.safety.requiresProfile === true,
      outputKind: h.safety.outputKind,
      variables: (h.variables ?? []).map((v) => ({
        name: v.name,
        required: v.required,
        description: v.description,
        ...(v.defaultValue !== undefined ? { defaultValue: v.defaultValue } : {}),
      })),
      operations: h.operations ?? [],
      manualChecklist: h.manualChecklist ?? [],
      tags: h.tags ?? [],
    });
  }
  return { entries, issues, files: loaded.files, rejected };
}

/** One helper by id, from the same catalog `helper list` prints. */
export async function findHelper(
  inspection: ISharkcraftInspection,
  id: string,
): Promise<IHelperView | null> {
  const catalog = await listAllHelpers(inspection);
  return catalog.entries.find((h) => h.id === id) ?? null;
}
