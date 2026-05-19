/**
 * Pack helper registry. Loads pack-contributed and locally-configured
 * helpers via `helperFiles[]`. Engine still ships its profile-driven generic
 * helpers (HelperId/core.*) — this registry is purely additive.
 */
import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import { validatePackHelper, type IPackHelper } from '@shrkcrft/plugin-api';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import { importModuleViaLoader } from '@shrkcrft/core';

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

async function importDefault<T>(file: string): Promise<readonly T[]> {
  const mod = (await importModuleViaLoader(file)) as {
    default?: readonly T[] | T;
    helpers?: readonly T[];
  };
  if (Array.isArray(mod.default)) return mod.default;
  if (mod.default && typeof mod.default === 'object') return [mod.default as T];
  if (Array.isArray(mod.helpers)) return mod.helpers;
  return [];
}

function localFiles(inspection: ISharkcraftInspection): string[] {
  const out: string[] = [];
  const dir = inspection.sharkcraftDir;
  if (!dir) return [];
  for (const name of ['helpers.ts', 'helpers/index.ts']) {
    const abs = nodePath.join(dir, name);
    if (existsSync(abs)) out.push(abs);
  }
  const cfg = inspection.config as { helperFiles?: readonly string[] } | null;
  for (const rel of cfg?.helperFiles ?? []) {
    out.push(nodePath.isAbsolute(rel) ? rel : nodePath.join(dir, rel));
  }
  return out;
}

export async function loadPackHelpers(
  inspection: ISharkcraftInspection,
): Promise<{ entries: readonly IPackHelperEntry[]; issues: readonly IPackHelperDoctorIssue[] }> {
  const entries: IPackHelperEntry[] = [];
  const issues: IPackHelperDoctorIssue[] = [];
  const seen = new Set<string>();

  const ingest = (
    raw: IPackHelper,
    source: PackHelperSource,
    packageName: string | undefined,
    sourceFile: string,
  ): void => {
    const v = validatePackHelper(raw);
    if (!v.valid) {
      for (const i of v.issues) {
        issues.push({
          severity: 'error',
          code: 'invalid-helper',
          message: `${i.field}: ${i.message}`,
          helperId: typeof raw.id === 'string' ? raw.id : undefined,
          source: sourceFile,
        });
      }
      return;
    }
    if (seen.has(raw.id)) {
      issues.push({
        severity: 'error',
        code: 'duplicate-id',
        message: `Helper "${raw.id}" already loaded; skipping ${sourceFile}.`,
        helperId: raw.id,
        source: sourceFile,
      });
      return;
    }
    seen.add(raw.id);
    entries.push({
      helper: raw,
      source,
      ...(packageName ? { packageName } : {}),
      sourceFile,
    });
  };

  for (const file of localFiles(inspection)) {
    try {
      const list = await importDefault<IPackHelper>(file);
      const rel = nodePath.relative(inspection.projectRoot, file) || file;
      for (const h of list) ingest(h, PackHelperSource.Local, undefined, rel);
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
    const contributions = (pack.manifest?.contributions ?? {}) as { helperFiles?: readonly string[] };
    for (const rel of contributions.helperFiles ?? []) {
      const file = nodePath.resolve(pack.packageRoot, rel);
      if (!existsSync(file)) {
        issues.push({
          severity: 'warning',
          code: 'missing-file',
          message: `Pack ${pack.packageName} declares ${rel} but file is missing.`,
          source: file,
        });
        continue;
      }
      try {
        const list = await importDefault<IPackHelper>(file);
        for (const h of list) ingest(h, PackHelperSource.Pack, pack.packageName, rel);
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
  return { entries, issues };
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
