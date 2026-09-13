import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { ILoadedBoundaryRulesFile } from '@shrkcrft/boundaries';
import type { IBoundaryConfigurationStatus } from './boundary-configuration-status.model.ts';
import type { IBoundaryLoadIssue } from './boundary-load-issue.model.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

/** The conventional local rule file — loaded ONLY when listed in `boundaryFiles`. */
export const DEFAULT_LOCAL_BOUNDARY_FILE = 'boundaries.ts';

/**
 * Classify the local `boundaryFiles` entries — THE code path both the
 * inspector's load loop and {@link describeBoundaryConfiguration} use, so the
 * loader and the diagnostics cannot disagree about which files exist.
 *
 * `unlistedDefault` is set when `sharkcraft/boundaries.ts` exists but no entry
 * points at it: the file an author naturally creates loads nothing until it is
 * listed. It is reported, never auto-loaded — auto-loading would start
 * enforcing rules silently (new exit 1s).
 */
export function classifyLocalBoundaryFiles(
  sharkcraftDir: string,
  boundaryFiles: readonly string[],
): {
  readonly listed: readonly { readonly rel: string; readonly abs: string; readonly exists: boolean }[];
  readonly unlistedDefault?: string;
} {
  const listed = boundaryFiles.map((rel) => {
    const abs = nodePath.join(sharkcraftDir, rel);
    return { rel, abs, exists: existsSync(abs) };
  });
  const defaultAbs = nodePath.join(sharkcraftDir, DEFAULT_LOCAL_BOUNDARY_FILE);
  const isListed = listed.some((l) => nodePath.resolve(l.abs) === nodePath.resolve(defaultAbs));
  return { listed, ...(existsSync(defaultAbs) && !isListed ? { unlistedDefault: defaultAbs } : {}) };
}

/** A path relative to the project root (`/`-separated), or the absolute path when outside it. */
export function boundaryFileLabel(projectRoot: string, abs: string): string {
  const rel = nodePath.relative(projectRoot, abs);
  if (rel === '' || rel.startsWith('..') || nodePath.isAbsolute(rel)) return abs;
  return rel.split(nodePath.sep).join('/');
}

/**
 * The structured load issues one loaded rule file carries — used by the
 * inspector (local + pack files) and `check boundaries --rule-file`, so every
 * origin reports a dropped rule the same way.
 */
export function boundaryLoadIssuesFromFile(
  loaded: ILoadedBoundaryRulesFile,
  projectRoot: string,
  origin: IBoundaryLoadIssue['origin'],
  packageName?: string,
): IBoundaryLoadIssue[] {
  const file = boundaryFileLabel(projectRoot, loaded.source);
  const base = { file, origin, ...(packageName ? { packageName } : {}) };
  const out: IBoundaryLoadIssue[] = [];
  if (loaded.missing) {
    out.push({ ...base, kind: 'missing-file', issues: ['the rule file does not exist'] });
  }
  if (loaded.loadError !== undefined) {
    out.push({ ...base, kind: 'load-error', issues: [loaded.loadError] });
  }
  for (const inv of loaded.invalid) {
    out.push({
      ...base,
      kind: 'invalid-rule',
      ...(inv.ruleId !== undefined ? { ruleId: inv.ruleId } : {}),
      index: inv.index,
      issues: inv.issues.map((i) => `${i.field}: ${i.message}`),
    });
  }
  return out;
}

/**
 * Are boundary rules configured, and if not, why? The one answer every
 * boundary surface renders (round 11, L-1).
 */
export function describeBoundaryConfiguration(inspection: ISharkcraftInspection): IBoundaryConfigurationStatus {
  const ruleCount = inspection.boundaryRegistry.size();
  const sharkcraftDir = inspection.sharkcraftDir;
  const listedLocalFiles = inspection.config?.boundaryFiles ?? [];
  const classified = sharkcraftDir
    ? classifyLocalBoundaryFiles(sharkcraftDir, listedLocalFiles)
    : { listed: [] as { rel: string; abs: string; exists: boolean }[] };
  const missingListed = classified.listed.filter((l) => !l.exists);
  const packBoundaryFiles: { packageName: string; file: string }[] = [];
  for (const pack of inspection.packs.validPacks) {
    for (const rel of pack.manifest?.contributions?.boundaryFiles ?? []) {
      packBoundaryFiles.push({ packageName: pack.packageName, file: nodePath.resolve(pack.packageRoot, rel) });
    }
  }
  const loadIssues = inspection.boundaryLoadIssues ?? [];
  const configInvalid = inspection.configLoadError !== undefined;
  const label = (abs: string): string => boundaryFileLabel(inspection.projectRoot, abs);

  const diagnostics: string[] = [];
  if (configInvalid) {
    diagnostics.push(
      `sharkcraft.config.ts failed to load (${inspection.configLoadError?.message ?? 'unknown error'}) — boundaryFiles could not be read; run \`shrk doctor\` (config-invalid).`,
    );
  }
  for (const m of missingListed) {
    diagnostics.push(`boundaryFiles lists "${m.rel}" but ${label(m.abs)} does not exist — no rules load from it.`);
  }
  if (classified.unlistedDefault) {
    diagnostics.push(
      `${label(classified.unlistedDefault)} exists but is not listed in boundaryFiles — its rules are NOT loaded. Add \`boundaryFiles: ['${DEFAULT_LOCAL_BOUNDARY_FILE}']\` to sharkcraft.config.ts.`,
    );
  }
  if (loadIssues.length > 0) {
    diagnostics.push(`${loadIssues.length} boundary rule(s) / rule file(s) failed to load — each is reported as an errored rule.`);
  }
  if (ruleCount === 0 && !configInvalid && missingListed.length === 0 && !classified.unlistedDefault) {
    if (!sharkcraftDir) {
      diagnostics.push(`No sharkcraft/ directory found under ${inspection.projectRoot} — no boundary rules can be loaded.`);
    } else if (listedLocalFiles.length === 0 && packBoundaryFiles.length === 0) {
      diagnostics.push(
        `No boundary rules loaded: ${inspection.configFile ? 'sharkcraft.config.ts lists no boundaryFiles' : 'no sharkcraft.config.ts was found'} and no pack contributes any. Create ${label(nodePath.join(sharkcraftDir, DEFAULT_LOCAL_BOUNDARY_FILE))} and list it: \`boundaryFiles: ['${DEFAULT_LOCAL_BOUNDARY_FILE}']\`.`,
      );
    } else if (loadIssues.length === 0) {
      // Only when nothing failed: a listed file that THREW, or whose every rule
      // failed validation, did not "load" — its load issues (above, and one
      // errored rule each) are the honest account.
      diagnostics.push('The listed boundary rule files loaded, but define no rules.');
    }
  }
  return {
    ruleCount,
    configured: ruleCount > 0,
    sharkcraftDir,
    configFile: inspection.configFile,
    configInvalid,
    listedLocalFiles,
    missingListedFiles: missingListed.map((m) => m.abs),
    ...(classified.unlistedDefault ? { unlistedDefaultFile: classified.unlistedDefault } : {}),
    packBoundaryFiles,
    loadIssues: loadIssues.length,
    diagnostics,
  };
}
