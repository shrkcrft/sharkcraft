/**
 * Language profile cache.
 *
 * Caches the most-recent `ILanguageProfileReport` under
 * `.sharkcraft/languages/cache.json` so large repos don't re-walk the tree
 * on every `shrk languages detect`. Opt-in: cache is only used when the
 * caller passes `--cache` (or `useCache: true`).
 *
 * Cache key signature:
 *  - project root absolute path
 *  - SharkCraft pkg version (caller-provided)
 *  - mtime + sizeBytes per known manifest file
 *  - file count + latest mtime per relevant extension
 *
 * Stale-cache rule: any mismatch on the signature returns the cached value
 * but flags it as stale; callers can decide to recompute.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { detectLanguageProfiles, type ILanguageProfileReport } from './language-detection.ts';

export const LANGUAGE_CACHE_SCHEMA = 'sharkcraft.language-cache/v1';

export interface ILanguageCacheSignature {
  projectRoot: string;
  sharkcraftVersion: string;
  manifestSignatures: Readonly<Record<string, { mtimeMs: number; sizeBytes: number }>>;
  extensionStats: Readonly<Record<string, { fileCount: number; latestMtimeMs: number }>>;
}

export interface ILanguageProfileCache {
  schema: typeof LANGUAGE_CACHE_SCHEMA;
  signature: ILanguageCacheSignature;
  report: ILanguageProfileReport;
  cachedAt: string;
}

export interface ILanguageCacheStatus {
  schema: typeof LANGUAGE_CACHE_SCHEMA;
  projectRoot: string;
  cacheFile: string;
  exists: boolean;
  cachedAt?: string;
  fresh: boolean;
  staleReasons: readonly string[];
}

const CACHE_REL_PATH = nodePath.join('.sharkcraft', 'languages', 'cache.json');

const MANIFEST_FILES: readonly string[] = [
  'package.json',
  'tsconfig.json',
  'bun.lockb',
  'pnpm-lock.yaml',
  'yarn.lock',
  'package-lock.json',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  'pyproject.toml',
  'requirements.txt',
  'setup.py',
  'poetry.lock',
  'uv.lock',
  'go.mod',
  'go.sum',
  'Cargo.toml',
  'Cargo.lock',
];

const TRACKED_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.js', '.java', '.cs', '.py', '.go', '.rs'];

function cachePathFor(projectRoot: string): string {
  return nodePath.join(projectRoot, CACHE_REL_PATH);
}

function statManifest(projectRoot: string, name: string): { mtimeMs: number; sizeBytes: number } | null {
  const abs = nodePath.join(projectRoot, name);
  if (!existsSync(abs)) return null;
  try {
    const st = statSync(abs);
    return { mtimeMs: Math.floor(st.mtimeMs), sizeBytes: st.size };
  } catch {
    return null;
  }
}

function buildExtensionStats(projectRoot: string): Record<string, { fileCount: number; latestMtimeMs: number }> {
  const out: Record<string, { fileCount: number; latestMtimeMs: number }> = {};
  for (const ext of TRACKED_EXTENSIONS) out[ext] = { fileCount: 0, latestMtimeMs: 0 };
  const stack: string[] = [projectRoot];
  const ignored = new Set(['node_modules', '.git', 'target', 'build', 'bin', 'obj', 'dist', 'out', '__pycache__', '.venv', 'venv', 'vendor', '.idea', '.vscode']);
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (ignored.has(e)) continue;
      const abs = nodePath.join(cur, e);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!st.isFile()) continue;
      const lower = e.toLowerCase();
      for (const ext of TRACKED_EXTENSIONS) {
        if (lower.endsWith(ext)) {
          const bucket = out[ext]!;
          bucket.fileCount += 1;
          if (st.mtimeMs > bucket.latestMtimeMs) bucket.latestMtimeMs = Math.floor(st.mtimeMs);
          break;
        }
      }
    }
  }
  return out;
}

export function computeLanguageCacheSignature(
  projectRoot: string,
  sharkcraftVersion: string,
): ILanguageCacheSignature {
  const manifestSignatures: Record<string, { mtimeMs: number; sizeBytes: number }> = {};
  for (const name of MANIFEST_FILES) {
    const s = statManifest(projectRoot, name);
    if (s) manifestSignatures[name] = s;
  }
  return {
    projectRoot,
    sharkcraftVersion,
    manifestSignatures,
    extensionStats: buildExtensionStats(projectRoot),
  };
}

function signaturesEqual(a: ILanguageCacheSignature, b: ILanguageCacheSignature): readonly string[] {
  const issues: string[] = [];
  if (a.projectRoot !== b.projectRoot) issues.push(`projectRoot mismatch (${a.projectRoot} vs ${b.projectRoot})`);
  if (a.sharkcraftVersion !== b.sharkcraftVersion) issues.push(`SharkCraft version drift (${a.sharkcraftVersion} vs ${b.sharkcraftVersion})`);
  const allManifest = new Set([...Object.keys(a.manifestSignatures), ...Object.keys(b.manifestSignatures)]);
  for (const name of allManifest) {
    const x = a.manifestSignatures[name];
    const y = b.manifestSignatures[name];
    if (!x || !y) {
      issues.push(`manifest ${name} added/removed`);
      continue;
    }
    if (x.mtimeMs !== y.mtimeMs || x.sizeBytes !== y.sizeBytes) {
      issues.push(`manifest ${name} changed (mtime/size)`);
    }
  }
  for (const ext of TRACKED_EXTENSIONS) {
    const x = a.extensionStats[ext];
    const y = b.extensionStats[ext];
    if (!x || !y) continue;
    if (x.fileCount !== y.fileCount) issues.push(`*${ext} file count drift (${x.fileCount} → ${y.fileCount})`);
    else if (Math.abs(x.latestMtimeMs - y.latestMtimeMs) > 1) issues.push(`*${ext} latest mtime drift`);
  }
  return issues;
}

export function loadLanguageCache(projectRoot: string): ILanguageProfileCache | null {
  const file = cachePathFor(projectRoot);
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if ((parsed as { schema?: string }).schema !== LANGUAGE_CACHE_SCHEMA) return null;
    return parsed as ILanguageProfileCache;
  } catch {
    return null;
  }
}

export function saveLanguageCache(cache: ILanguageProfileCache): void {
  const file = cachePathFor(cache.signature.projectRoot);
  mkdirSync(nodePath.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(cache, null, 2), 'utf8');
}

export interface IDetectLanguagesWithCacheOptions {
  projectRoot: string;
  sharkcraftVersion: string;
  /** When true, attempt to use the cache (default: true if call site asks). */
  useCache?: boolean;
  /** When true, refresh and overwrite the cache after running detection. */
  refresh?: boolean;
}

export interface IDetectLanguagesWithCacheResult {
  report: ILanguageProfileReport;
  cacheHit: boolean;
  staleReasons: readonly string[];
}

export function detectLanguageProfilesWithCache(
  options: IDetectLanguagesWithCacheOptions,
): IDetectLanguagesWithCacheResult {
  const signature = computeLanguageCacheSignature(options.projectRoot, options.sharkcraftVersion);
  if (options.useCache !== false) {
    const cached = loadLanguageCache(options.projectRoot);
    if (cached) {
      const issues = signaturesEqual(signature, cached.signature);
      if (issues.length === 0) {
        return { report: cached.report, cacheHit: true, staleReasons: [] };
      }
      if (!options.refresh) {
        return { report: cached.report, cacheHit: true, staleReasons: issues };
      }
    }
  }
  const report = detectLanguageProfiles(options.projectRoot);
  const next: ILanguageProfileCache = {
    schema: LANGUAGE_CACHE_SCHEMA,
    signature,
    report,
    cachedAt: new Date().toISOString(),
  };
  try {
    saveLanguageCache(next);
  } catch {
    // ignore write failures — cache is best-effort.
  }
  return { report, cacheHit: false, staleReasons: [] };
}

export function getLanguageCacheStatus(
  projectRoot: string,
  sharkcraftVersion: string,
): ILanguageCacheStatus {
  const file = cachePathFor(projectRoot);
  const cached = loadLanguageCache(projectRoot);
  if (!cached) {
    return {
      schema: LANGUAGE_CACHE_SCHEMA,
      projectRoot,
      cacheFile: file,
      exists: false,
      fresh: false,
      staleReasons: [],
    };
  }
  const signature = computeLanguageCacheSignature(projectRoot, sharkcraftVersion);
  const issues = signaturesEqual(signature, cached.signature);
  return {
    schema: LANGUAGE_CACHE_SCHEMA,
    projectRoot,
    cacheFile: file,
    exists: true,
    cachedAt: cached.cachedAt,
    fresh: issues.length === 0,
    staleReasons: issues,
  };
}

export function clearLanguageCache(projectRoot: string, options: { write?: boolean } = {}): { cleared: boolean; cacheFile: string } {
  const file = cachePathFor(projectRoot);
  if (!options.write) return { cleared: false, cacheFile: file };
  if (existsSync(file)) {
    rmSync(file, { force: true });
    return { cleared: true, cacheFile: file };
  }
  return { cleared: false, cacheFile: file };
}
