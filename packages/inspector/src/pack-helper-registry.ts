/**
 * Pack helper registry. Loads pack-contributed and locally-configured
 * helpers via `helperFiles[]`. Engine still ships its profile-driven generic
 * helpers (HelperId/core.*) — this registry is purely additive.
 */
import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import { validatePackHelper, type IPackHelper } from '@shrkcrft/plugin-api';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import {
  importModuleViaLoader,
  readContributionExport,
  RejectionCause,
  type IContributionExport,
  type IRejectedEntry,
} from '@shrkcrft/core';

/**
 * THE helper acceptance predicate (round 12, 12.1): every ERROR of
 * `validatePackHelper` (a warning never refuses a helper), `<field>:
 * <message>` — `[]` means accepted.
 */
export function packHelperRejectionReasons(raw: unknown): readonly string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['(entry): must be an object'];
  const v = validatePackHelper(raw as IPackHelper);
  if (v.valid) return [];
  const errors = v.issues.filter((i) => i.severity !== 'warning');
  return (errors.length > 0 ? errors : v.issues).map((i) => `${i.field}: ${i.message}`);
}

export const PACK_HELPER_REGISTRY_SCHEMA = 'sharkcraft.pack-helper-registry/v1';

export enum PackHelperSource {
  Local = 'local',
  Pack = 'pack',
  Fixture = 'fixture',
}

export interface IPackHelperEntry {
  readonly helper: IPackHelper;
  readonly source: PackHelperSource;
  readonly packageName?: string;
  readonly sourceFile: string;
}

export interface IPackHelperDoctorIssue {
  readonly severity: 'info' | 'warning' | 'error';
  readonly code: string;
  readonly message: string;
  readonly helperId?: string;
  readonly source?: string;
}

async function importHelpers(file: string): Promise<IContributionExport> {
  return readContributionExport(await importModuleViaLoader(file), { namedKeys: ['helpers'] });
}

function localFiles(inspection: ISharkcraftInspection): string[] {
  const out: string[] = [];
  const dir = inspection.sharkcraftDir;
  if (!dir) return [];
  for (const name of ['helpers.ts', 'helpers/index.ts']) {
    const abs = nodePath.join(dir, name);
    if (existsSync(abs)) out.push(abs);
  }
  // More helper files come from pack manifests (`helperFiles`, loaded below) —
  // there is no local-config key for them; the strict config schema rejects
  // one, so a local read here could never be reached.
  return out;
}

export async function loadPackHelpers(
  inspection: ISharkcraftInspection,
): Promise<{
  entries: readonly IPackHelperEntry[];
  issues: readonly IPackHelperDoctorIssue[];
  /** Every helper file this load considered (absolute path) and what happened to it. */
  files: readonly { readonly file: string; readonly status: 'loaded' | 'failed' | 'missing' }[];
  /** Every declared helper the loader refused — invalid or a duplicate id (round 12, 12.1). */
  rejected: readonly IRejectedEntry[];
}> {
  const entries: IPackHelperEntry[] = [];
  const issues: IPackHelperDoctorIssue[] = [];
  const rejected: IRejectedEntry[] = [];
  const files: { file: string; status: 'loaded' | 'failed' | 'missing' }[] = [];
  const seen = new Map<string, string>();

  const ingest = (
    raw: unknown,
    source: PackHelperSource,
    packageName: string | undefined,
    sourceFile: string,
    at: Pick<IRejectedEntry, 'file' | 'index' | 'exportName'>,
  ): void => {
    const rawId = raw && typeof raw === 'object' ? (raw as { id?: unknown }).id : undefined;
    const helperId = typeof rawId === 'string' ? rawId : undefined;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const i of validatePackHelper(raw as IPackHelper).issues) {
        // Errors make the helper invalid (skipped); warnings (e.g. an unknown key
        // on an operation, which the engine would silently drop) still surface.
        const warning = i.severity === 'warning';
        issues.push({
          severity: warning ? 'warning' : 'error',
          code: warning ? 'helper-warning' : 'invalid-helper',
          message: `${i.field}: ${i.message}`,
          ...(helperId ? { helperId } : {}),
          source: sourceFile,
        });
      }
    }
    const reasons = packHelperRejectionReasons(raw);
    if (reasons.length > 0) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        issues.push({ severity: 'error', code: 'invalid-helper', message: reasons[0]!, source: sourceFile });
      }
      rejected.push({ ...at, ...(helperId ? { entryId: helperId } : {}), reasons, cause: RejectionCause.Invalid });
      return;
    }
    const helper = raw as IPackHelper;
    const prev = seen.get(helper.id);
    if (prev !== undefined) {
      issues.push({
        severity: 'error',
        code: 'duplicate-id',
        message: `Helper "${helper.id}" already loaded; skipping ${sourceFile}.`,
        helperId: helper.id,
        source: sourceFile,
      });
      rejected.push({
        ...at,
        entryId: helper.id,
        reasons: [`id: "${helper.id}" is already declared in ${prev}`],
        cause: RejectionCause.DuplicateId,
      });
      return;
    }
    seen.set(helper.id, sourceFile);
    entries.push({
      helper,
      source,
      ...(packageName ? { packageName } : {}),
      sourceFile,
    });
  };
  const ingestAll = (
    exp: IContributionExport,
    file: string,
    source: PackHelperSource,
    packageName: string | undefined,
    sourceFile: string,
  ): void => {
    exp.items.forEach((h, i) =>
      ingest(h, source, packageName, sourceFile, {
        file,
        index: exp.single ? -1 : i,
        ...(exp.exportName ? { exportName: exp.exportName } : {}),
      }),
    );
  };

  for (const file of localFiles(inspection)) {
    try {
      const exp = await importHelpers(file);
      const rel = nodePath.relative(inspection.projectRoot, file) || file;
      files.push({ file, status: 'loaded' });
      ingestAll(exp, file, PackHelperSource.Local, undefined, rel);
    } catch (e) {
      files.push({ file, status: 'failed' });
      // A helper file that cannot be imported contributes nothing: an error,
      // like every other contribution load failure.
      issues.push({
        severity: 'error',
        code: 'load-failed',
        message: `Failed to load ${file}: ${(e as Error).message}`,
        source: file,
      });
    }
  }
  for (const pack of inspection.packs.validPacks ?? []) {
    const contributions = (pack.manifest?.contributions ?? {}) as { helperFiles?: readonly string[] };
    for (const rel of contributions.helperFiles ?? []) {
      const file = nodePath.resolve(pack.packageRoot, rel);
      if (!existsSync(file)) {
        files.push({ file, status: 'missing' });
        issues.push({
          severity: 'error',
          code: 'missing-file',
          message: `Pack ${pack.packageName} declares ${rel} but file is missing.`,
          source: file,
        });
        continue;
      }
      try {
        const exp = await importHelpers(file);
        files.push({ file, status: 'loaded' });
        ingestAll(exp, file, PackHelperSource.Pack, pack.packageName, rel);
      } catch (e) {
        files.push({ file, status: 'failed' });
        issues.push({
          severity: 'error',
          code: 'load-failed',
          message: `Pack ${pack.packageName} (${rel}): ${(e as Error).message}`,
          source: file,
        });
      }
    }
  }
  return { entries, issues, files, rejected };
}

export async function listPackHelpers(
  inspection: ISharkcraftInspection,
): Promise<readonly IPackHelperEntry[]> {
  const { entries } = await loadPackHelpers(inspection);
  return entries;
}

export async function findPackHelper(
  inspection: ISharkcraftInspection,
  id: string,
): Promise<IPackHelperEntry | null> {
  const entries = await listPackHelpers(inspection);
  return entries.find((e) => e.helper.id === id) ?? null;
}

export async function listPackHelperIssues(
  inspection: ISharkcraftInspection,
): Promise<readonly IPackHelperDoctorIssue[]> {
  const { issues } = await loadPackHelpers(inspection);
  return issues;
}
