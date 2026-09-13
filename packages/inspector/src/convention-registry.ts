/**
 * Convention registry. Loads pack + local conventions and validates
 * them. Engine has no built-in conventions; everything comes from
 * contributions.
 */
import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  ConventionSeverity,
  validateConvention,
  type IConvention,
} from '@shrkcrft/plugin-api';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import { conventionFilePath, conventionScope } from './convention-applicability.ts';
import type { INotApplicableConvention } from './i-not-applicable-convention.ts';
import {
  importModuleViaLoader,
  readContributionExport,
  RejectionCause,
  type IContributionExport,
  type IRejectedEntry,
} from '@shrkcrft/core';

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
  readonly severity: ConventionSeverity;
  readonly code: string;
  readonly message: string;
  readonly conventionId?: string;
  readonly source?: string;
}

/** The convention FILES a load discovered, and the ones it could not read — the doctor's coverage. */
export interface IConventionFileScan {
  /** Every convention file the load tried (local defaults, `conventionFiles`, pack `conventionFiles`). */
  readonly discovered: number;
  /** Discovered but never read (missing, or failed to import) — `file — reason`, project-relative. */
  readonly unread: readonly string[];
}

async function importConventions(file: string): Promise<IContributionExport> {
  return readContributionExport(await importModuleViaLoader(file), { namedKeys: ['conventions'] });
}

/**
 * THE convention acceptance predicate (round 12, 12.1): every error of
 * `validateConvention`, `<field>: <message>` — `[]` means accepted. The
 * loader and `packs test --load` refuse exactly the same entries.
 */
export function conventionRejectionReasons(raw: unknown): readonly string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['(entry): must be an object'];
  const v = validateConvention(raw as IConvention);
  if (v.valid) return [];
  return v.issues.length > 0 ? v.issues.map((i) => `${i.field}: ${i.message}`) : ['(entry): failed validation'];
}

/** A declared entry's string `id`, when it has one. */
function entryIdOf(raw: unknown): string | undefined {
  const id = raw && typeof raw === 'object' ? (raw as { id?: unknown }).id : undefined;
  return typeof id === 'string' ? id : undefined;
}

function localFiles(inspection: ISharkcraftInspection): string[] {
  const out: string[] = [];
  const dir = inspection.sharkcraftDir;
  if (!dir) return [];
  for (const name of ['conventions.ts', 'conventions/index.ts']) {
    const abs = nodePath.join(dir, name);
    if (existsSync(abs)) out.push(abs);
  }
  // `conventionFiles` is a declared config key (typed, schema-validated).
  for (const rel of inspection.config?.conventionFiles ?? []) {
    out.push(nodePath.isAbsolute(rel) ? rel : nodePath.join(dir, rel));
  }
  // One scan per DISTINCT file: `conventionFiles: ['conventions.ts']` names the
  // default file again, and loading it twice listed every doctor issue twice.
  return [...new Set(out.map((f) => nodePath.resolve(f)))];
}

export async function loadConventions(
  inspection: ISharkcraftInspection,
): Promise<{
  entries: readonly IConventionEntry[];
  issues: readonly IConventionDoctorIssue[];
  files: IConventionFileScan;
  /**
   * Every declared convention the loader refused (round 12, 12.1) — invalid
   * or a duplicate id — with its position and every reason. The `issues`
   * above still carry the per-field `invalid-convention` lines `conventions
   * doctor` prints; this is the record THE rejection channel lifts.
   */
  rejected: readonly IRejectedEntry[];
}> {
  const entries: IConventionEntry[] = [];
  const issues: IConventionDoctorIssue[] = [];
  const rejected: IRejectedEntry[] = [];
  const seen = new Map<string, string>();
  let discovered = 0;
  const unread: string[] = [];
  const rel = (file: string): string => nodePath.relative(inspection.projectRoot, file) || file;

  const ingest = (
    raw: unknown,
    source: ConventionSource,
    packageName: string | undefined,
    sourceFile: string,
    at: Pick<IRejectedEntry, 'file' | 'index' | 'exportName'>,
  ): void => {
    const id = entryIdOf(raw);
    // Shape warnings never drop the convention; they are said out loud.
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const w of validateConvention(raw as IConvention).warnings) {
        issues.push({
          severity: ConventionSeverity.Warning,
          code: 'convention-shape',
          message: `${w.field}: ${w.message}`,
          conventionId: id,
          source: sourceFile,
        });
      }
    }
    const reasons = conventionRejectionReasons(raw);
    if (reasons.length > 0) {
      for (const r of reasons) {
        issues.push({ severity: ConventionSeverity.Error, code: 'invalid-convention', message: r, conventionId: id, source: sourceFile });
      }
      rejected.push({ ...at, ...(id !== undefined ? { entryId: id } : {}), reasons, cause: RejectionCause.Invalid });
      return;
    }
    const conv = raw as IConvention;
    const prev = seen.get(conv.id);
    if (prev !== undefined) {
      issues.push({
        severity: ConventionSeverity.Error,
        code: 'duplicate-id',
        message: `Convention "${conv.id}" already loaded; skipping ${sourceFile}.`,
        conventionId: conv.id,
        source: sourceFile,
      });
      rejected.push({
        ...at,
        entryId: conv.id,
        reasons: [`id: "${conv.id}" is already declared in ${prev}`],
        cause: RejectionCause.DuplicateId,
      });
      return;
    }
    seen.set(conv.id, sourceFile);
    entries.push({
      convention: conv,
      source,
      ...(packageName ? { packageName } : {}),
      sourceFile,
    });
  };
  const ingestAll = (
    exp: IContributionExport,
    file: string,
    source: ConventionSource,
    packageName: string | undefined,
    sourceFile: string,
  ): void => {
    exp.items.forEach((c, i) =>
      ingest(c, source, packageName, sourceFile, {
        file,
        index: exp.single ? -1 : i,
        ...(exp.exportName ? { exportName: exp.exportName } : {}),
      }),
    );
  };

  for (const file of localFiles(inspection)) {
    discovered += 1;
    try {
      ingestAll(await importConventions(file), file, ConventionSource.Local, undefined, rel(file));
    } catch (e) {
      unread.push(`${rel(file)} — failed to load`);
      issues.push({
        severity: ConventionSeverity.Warning,
        code: 'load-failed',
        message: `Failed to load ${file}: ${(e as Error).message}`,
        source: file,
      });
    }
  }
  for (const pack of inspection.packs.validPacks ?? []) {
    const contributions = (pack.manifest?.contributions ?? {}) as { conventionFiles?: readonly string[] };
    for (const packRel of contributions.conventionFiles ?? []) {
      discovered += 1;
      const file = nodePath.resolve(pack.packageRoot, packRel);
      if (!existsSync(file)) {
        unread.push(`${rel(file)} — missing (declared by ${pack.packageName})`);
        issues.push({
          severity: ConventionSeverity.Warning,
          code: 'missing-file',
          message: `Pack ${pack.packageName} declares ${packRel} but file is missing.`,
          source: file,
        });
        continue;
      }
      try {
        ingestAll(await importConventions(file), file, ConventionSource.Pack, pack.packageName, packRel);
      } catch (e) {
        unread.push(`${rel(file)} — failed to load (${pack.packageName})`);
        issues.push({
          severity: ConventionSeverity.Warning,
          code: 'load-failed',
          message: `Pack ${pack.packageName} (${packRel}): ${(e as Error).message}`,
          source: file,
        });
      }
    }
  }
  return { entries, issues, files: { discovered, unread }, rejected };
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
  readonly severity: ConventionSeverity;
  readonly message: string;
}

export interface IConventionCheckReport {
  readonly schema: 'sharkcraft.convention-check/v1';
  readonly filesScanned: number;
  readonly hits: readonly IConventionCheckHit[];
  readonly verdict: 'clean' | 'has-violations';
  /**
   * Conventions that do not apply here (round 15, 15.1) — never evaluated, each
   * with the `appliesTo` filters that excluded it. `conventions check` prints
   * every one and accepts it explicitly (`acceptedBy: 'appliesTo'`).
   */
  readonly notApplicable: readonly INotApplicableConvention[];
  /** How many files in scope each APPLICABLE convention covers, by id (round 15). */
  readonly filesInScope: Readonly<Record<string, number>>;
}

/**
 * Run the loaded conventions against `files`. Which files a convention covers
 * is `conventionScope` — THE applicability authority (round 15), the same one
 * the rule-graph bridge reads — so every `appliesTo` filter scopes, `**`
 * spans zero or more segments, and a `!` glob subtracts (a private matcher
 * here missed `src/a.ts` under `src/**\/*.ts` and ignored `!`). A convention
 * that does not apply is never evaluated and is reported in `notApplicable`.
 *
 * Per covered file, each rule: `filePattern` and `expectMatch` must match the
 * path (a miss is a hit), `forbidMatch` must not (a match is a hit).
 *
 * Every file is read in ONE spelling — `conventionFilePath` (project-relative,
 * `/`-separated, no `./`), the one the scope test reads — so a rule pattern
 * never tests a spelling the glob did not, and a hit names that path (round 15
 * review: `./src/a.ts` was covered by `src/**` and then failed `^src/`).
 */
export async function checkConventionsAgainstFiles(
  inspection: ISharkcraftInspection,
  inputFiles: readonly string[],
): Promise<IConventionCheckReport> {
  const files = inputFiles.map((f) => conventionFilePath(inspection, f));
  const entries = await listConventions(inspection);
  const hits: IConventionCheckHit[] = [];
  const notApplicable: INotApplicableConvention[] = [];
  const filesInScope: Record<string, number> = {};
  const covered = new Map<string, ReadonlySet<string>>();
  for (const entry of entries) {
    const c = entry.convention;
    const scope = conventionScope(c, inspection, files);
    if (!scope.applicable) {
      notApplicable.push({
        conventionId: c.id,
        severity: c.severity,
        sourceFile: entry.sourceFile,
        ...(entry.packageName ? { packageName: entry.packageName } : {}),
        reasons: scope.reasons.filter((r) => !r.matched),
      });
      continue;
    }
    filesInScope[c.id] = scope.files.length;
    covered.set(c.id, new Set(scope.files));
  }
  for (const f of files) {
    for (const entry of entries) {
      const c = entry.convention;
      if (!covered.get(c.id)?.has(f)) continue;
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
        if (r.expectMatch && !new RegExp(r.expectMatch).test(f)) {
          hits.push({
            conventionId: c.id,
            ruleId: r.id,
            file: f,
            severity: sev,
            message: `File "${f}" does not match the expected pattern /${r.expectMatch}/ of convention "${c.id}" rule "${r.id}": ${r.description}`,
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
    verdict: hits.some((h) => h.severity === ConventionSeverity.Error) ? 'has-violations' : 'clean',
    notApplicable,
    filesInScope,
  };
}
