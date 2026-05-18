/**
 * Convention registry. Loads pack + local conventions and validates
 * them. Engine has no built-in conventions; everything comes from
 * contributions.
 */
import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  validateConvention,
  type IConvention,
} from '@shrkcrft/plugin-api';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const CONVENTION_REGISTRY_SCHEMA = 'sharkcraft.convention-registry/v1';

export enum ConventionSource {
  Local = 'local',
  Pack = 'pack',
  Fixture = 'fixture',
}

export interface IConventionEntry {
  readonly convention: IConvention;
  readonly source: ConventionSource;
  readonly packageName?: string;
  readonly sourceFile: string;
}

export interface IConventionDoctorIssue {
  readonly severity: 'info' | 'warning' | 'error';
  readonly code: string;
  readonly message: string;
  readonly conventionId?: string;
  readonly source?: string;
}

async function importDefault<T>(file: string): Promise<readonly T[]> {
  const mod = (await import(pathToFileURL(file).href)) as {
    default?: readonly T[] | T;
    conventions?: readonly T[];
  };
  if (Array.isArray(mod.default)) return mod.default;
  if (mod.default && typeof mod.default === 'object') return [mod.default as T];
  if (Array.isArray(mod.conventions)) return mod.conventions;
  return [];
}

function localFiles(inspection: ISharkcraftInspection): string[] {
  const out: string[] = [];
  const dir = inspection.sharkcraftDir;
  if (!dir) return [];
  for (const name of ['conventions.ts', 'conventions/index.ts']) {
    const abs = nodePath.join(dir, name);
    if (existsSync(abs)) out.push(abs);
  }
  const cfg = inspection.config as { conventionFiles?: readonly string[] } | null;
  for (const rel of cfg?.conventionFiles ?? []) {
    out.push(nodePath.isAbsolute(rel) ? rel : nodePath.join(dir, rel));
  }
  return out;
}

export async function loadConventions(
  inspection: ISharkcraftInspection,
): Promise<{ entries: readonly IConventionEntry[]; issues: readonly IConventionDoctorIssue[] }> {
  const entries: IConventionEntry[] = [];
  const issues: IConventionDoctorIssue[] = [];
  const seen = new Set<string>();

  const ingest = (
    raw: IConvention,
    source: ConventionSource,
    packageName: string | undefined,
    sourceFile: string,
  ): void => {
    const v = validateConvention(raw);
    if (!v.valid) {
      for (const i of v.issues) {
        issues.push({
          severity: 'error',
          code: 'invalid-convention',
          message: `${i.field}: ${i.message}`,
          conventionId: typeof raw.id === 'string' ? raw.id : undefined,
          source: sourceFile,
        });
      }
      return;
    }
    if (seen.has(raw.id)) {
      issues.push({
        severity: 'error',
        code: 'duplicate-id',
        message: `Convention "${raw.id}" already loaded; skipping ${sourceFile}.`,
        conventionId: raw.id,
        source: sourceFile,
      });
      return;
    }
    seen.add(raw.id);
    entries.push({
      convention: raw,
      source,
      ...(packageName ? { packageName } : {}),
      sourceFile,
    });
  };

  for (const file of localFiles(inspection)) {
    try {
      const list = await importDefault<IConvention>(file);
      const rel = nodePath.relative(inspection.projectRoot, file) || file;
      for (const c of list) ingest(c, ConventionSource.Local, undefined, rel);
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
    const contributions = (pack.manifest?.contributions ?? {}) as { conventionFiles?: readonly string[] };
    for (const rel of contributions.conventionFiles ?? []) {
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
        const list = await importDefault<IConvention>(file);
        for (const c of list) ingest(c, ConventionSource.Pack, pack.packageName, rel);
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

export async function listConventions(
  inspection: ISharkcraftInspection,
): Promise<readonly IConventionEntry[]> {
  const { entries } = await loadConventions(inspection);
  return entries;
}

export async function findConvention(
  inspection: ISharkcraftInspection,
  id: string,
): Promise<IConventionEntry | null> {
  const entries = await listConventions(inspection);
  return entries.find((e) => e.convention.id === id) ?? null;
}

export async function listConventionIssues(
  inspection: ISharkcraftInspection,
): Promise<readonly IConventionDoctorIssue[]> {
  const { issues } = await loadConventions(inspection);
  return issues;
}

export interface IConventionCheckHit {
  readonly conventionId: string;
  readonly ruleId: string;
  readonly file: string;
  readonly line?: number;
  readonly severity: 'info' | 'warning' | 'error';
  readonly message: string;
}

export interface IConventionCheckReport {
  readonly schema: 'sharkcraft.convention-check/v1';
  readonly filesScanned: number;
  readonly hits: readonly IConventionCheckHit[];
  readonly verdict: 'clean' | 'has-violations';
}

function globMatch(file: string, pattern: string): boolean {
  // very small POSIX-style matcher: ** = any path, * = any segment chars
  const re = new RegExp(
    '^' +
      pattern
        .replace(/[.+^$()|]/g, (m) => '\\' + m)
        .replace(/\*\*/g, '__DOUBLE__')
        .replace(/\*/g, '[^/]*')
        .replace(/__DOUBLE__/g, '.*')
        .replace(/\?/g, '.') +
      '$',
  );
  return re.test(file);
}

export async function checkConventionsAgainstFiles(
  inspection: ISharkcraftInspection,
  files: readonly string[],
): Promise<IConventionCheckReport> {
  const entries = await listConventions(inspection);
  const hits: IConventionCheckHit[] = [];
  for (const f of files) {
    for (const entry of entries) {
      const c = entry.convention;
      const globs = c.appliesTo?.fileGlobs ?? [];
      if (globs.length > 0 && !globs.some((g) => globMatch(f, g))) continue;
      for (const r of c.rules) {
        const sev = r.severity ?? c.severity;
        if (r.filePattern && !new RegExp(r.filePattern).test(f)) {
          hits.push({
            conventionId: c.id,
            ruleId: r.id,
            file: f,
            severity: sev,
            message: `File "${f}" does not match convention "${c.id}" rule "${r.id}": ${r.description}`,
          });
        }
        if (r.forbidMatch && new RegExp(r.forbidMatch).test(f)) {
          hits.push({
            conventionId: c.id,
            ruleId: r.id,
            file: f,
            severity: sev,
            message: `File "${f}" matches forbidden pattern from convention "${c.id}" rule "${r.id}": ${r.description}`,
          });
        }
      }
    }
  }
  return {
    schema: 'sharkcraft.convention-check/v1',
    filesScanned: files.length,
    hits,
    verdict: hits.some((h) => h.severity === 'error') ? 'has-violations' : 'clean',
  };
}
