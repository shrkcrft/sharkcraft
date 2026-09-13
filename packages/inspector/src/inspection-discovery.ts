import * as nodePath from 'node:path';
import { detectProjectRoot, findConfiguredAncestor } from '@shrkcrft/config';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import type { IKnowledgeLoadFailure } from './knowledge-load-failure.ts';
import type { ILoaderDiagnostic } from './loader-diagnostics.ts';

/** The loader slots whose entries feed `inspection.knowledgeEntries`. */
const KNOWLEDGE_LOADER_KINDS: ReadonlySet<string> = new Set(['knowledge', 'rules', 'paths', 'docs']);

/** `failed` / `timeout` / `cached-failed` / `missing`, or `ok` for a file whose entries loaded. */
function loadOutcome(d: ILoaderDiagnostic): string {
  if (d.status === 'cached-skip') {
    return d.cachedStatus !== undefined && d.cachedStatus !== 'ok' ? 'cached-failed' : 'ok';
  }
  return d.status;
}

/**
 * Every knowledge-bearing file the loaders were told about, and the ones whose
 * entries never reached the corpus — read off `inspection.loaderDiagnostics`,
 * the one record of what each loader did.
 */
function knowledgeLoadOutcomes(inspection: ISharkcraftInspection): {
  readonly attempted: number;
  readonly failures: readonly IKnowledgeLoadFailure[];
} {
  const byFile = new Map<string, ILoaderDiagnostic>();
  for (const d of inspection.loaderDiagnostics ?? []) {
    if (!KNOWLEDGE_LOADER_KINDS.has(d.kind)) continue;
    const key = nodePath.resolve(d.filePath);
    const prior = byFile.get(key);
    // A failure recorded for a file wins over an ok one (never folded into it).
    if (!prior || (loadOutcome(prior) === 'ok' && loadOutcome(d) !== 'ok')) byFile.set(key, d);
  }
  const rel = (abs: string): string => {
    const r = nodePath.relative(inspection.projectRoot, abs);
    return r && !r.startsWith('..') && !nodePath.isAbsolute(r) ? r.split(nodePath.sep).join('/') : abs;
  };
  const failures: IKnowledgeLoadFailure[] = [];
  for (const d of byFile.values()) {
    const status = loadOutcome(d);
    if (status === 'ok') continue;
    failures.push({
      file: rel(d.filePath),
      kind: d.kind,
      status,
      message:
        d.errorMessage ??
        (status === 'missing' ? 'declared by the config, but the file does not exist' : `the ${d.kind} loader reported ${status}`),
      ...(d.packName ? { packName: d.packName } : {}),
    });
  }
  failures.sort((a, b) => a.file.localeCompare(b.file));
  return { attempted: byFile.size, failures };
}

/**
 * Where discovery landed, and why — read by any verdict that must refuse to
 * pass over a corpus it never loaded.
 *
 * A corpus check run from a nested package (its own package.json, no
 * `sharkcraft/` folder) resolves that package as the root, loads 0 entries, and
 * used to print `ok=0 stale=0` with exit 0. The disconfirming facts were all on
 * the inspection; nothing put them in front of the reader.
 */
export interface IInspectionDiscovery {
  /** The directory discovery started from (the caller's cwd). */
  readonly startDir: string;
  /** The project root the inspection resolved — the nearest ancestor carrying a root marker. */
  readonly resolvedRoot: string;
  /** Which markers made {@link resolvedRoot} a root (`package.json`, `.git`, …). */
  readonly rootMarkers: readonly string[];
  readonly sharkcraftDir: string | null;
  readonly configFile: string | null;
  /** The loader's message when a config file EXISTS but failed to load. */
  readonly configError?: string;
  /** Knowledge entries loaded. */
  readonly entriesLoaded: number;
  /** Knowledge-bearing files the loaders were told about (local + pack; missing ones included). */
  readonly knowledgeFilesAttempted: number;
  /**
   * Knowledge-bearing files whose entries never reached the corpus (failed,
   * timed out, a cached failure, or declared and missing). Non-empty = the
   * corpus is PARTIAL: a stale-check over it is never a pass, and
   * `--allow-empty` never clears it.
   */
  readonly knowledgeLoadFailures: readonly IKnowledgeLoadFailure[];
  /**
   * When {@link resolvedRoot} has no `sharkcraft/` folder: the nearest ancestor
   * (up to the repository top) that has one — the `--cwd` to rerun with.
   */
  readonly configuredAncestor?: string;
}

/**
 * Describe the inspection's discovery. The ONE reader of "where did discovery
 * land": the stale-check refusal, its JSON, and the MCP stale tool all call it.
 */
export function describeInspectionDiscovery(
  inspection: ISharkcraftInspection,
  startDir: string = inspection.projectRoot,
): IInspectionDiscovery {
  const ancestor = inspection.hasSharkcraftFolder
    ? null
    : findConfiguredAncestor(inspection.projectRoot);
  const loads = knowledgeLoadOutcomes(inspection);
  return {
    startDir,
    resolvedRoot: inspection.projectRoot,
    rootMarkers: detectProjectRoot(inspection.projectRoot).markers,
    sharkcraftDir: inspection.sharkcraftDir,
    configFile: inspection.configFile,
    ...(inspection.configLoadError ? { configError: inspection.configLoadError.message } : {}),
    entriesLoaded: inspection.knowledgeEntries.length,
    knowledgeFilesAttempted: loads.attempted,
    knowledgeLoadFailures: loads.failures,
    ...(ancestor ? { configuredAncestor: ancestor } : {}),
  };
}
