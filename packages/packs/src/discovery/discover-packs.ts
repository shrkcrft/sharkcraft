import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PACK_SECRET_ENV,
  validatePackManifest,
  verifyPackManifest,
  type ISharkCraftPackContributions,
  type ISharkCraftPackManifest,
} from '@shrkcrft/plugin-api';
import type { IDiscoveredPack, IPackDiscoveryResult } from '../model/pack-discovery.ts';

interface IPackageJsonMinimal {
  name?: string;
  version?: string;
  sharkcraft?: string | { manifest?: string };
}

function readPackageJson(pkgPath: string): IPackageJsonMinimal | null {
  try {
    return JSON.parse(readFileSync(pkgPath, 'utf8')) as IPackageJsonMinimal;
  } catch {
    return null;
  }
}

function resolveManifestPath(packageRoot: string, manifestField: unknown): string | null {
  if (typeof manifestField === 'string') {
    return nodePath.resolve(packageRoot, manifestField);
  }
  if (manifestField && typeof manifestField === 'object') {
    const m = (manifestField as { manifest?: unknown }).manifest;
    if (typeof m === 'string') return nodePath.resolve(packageRoot, m);
  }
  return null;
}

function emptyCounts(): IDiscoveredPack['contributionCounts'] {
  return {
    knowledgeFiles: 0,
    ruleFiles: 0,
    pathFiles: 0,
    templateFiles: 0,
    pipelineFiles: 0,
    docsFiles: 0,
    presetFiles: 0,
    scaffoldPatternFiles: 0,
    policyCheckFiles: 0,
    constructFiles: 0,
    constructFacetFiles: 0,
    playbookFiles: 0,
  };
}

function countContributions(c: ISharkCraftPackContributions | undefined): IDiscoveredPack['contributionCounts'] {
  const out = emptyCounts();
  if (!c) return out;
  out.knowledgeFiles = c.knowledgeFiles?.length ?? 0;
  out.ruleFiles = c.ruleFiles?.length ?? 0;
  out.pathFiles = c.pathFiles?.length ?? 0;
  out.templateFiles = c.templateFiles?.length ?? 0;
  out.pipelineFiles = c.pipelineFiles?.length ?? 0;
  out.docsFiles = c.docsFiles?.length ?? 0;
  out.presetFiles = c.presetFiles?.length ?? 0;
  out.scaffoldPatternFiles = c.scaffoldPatternFiles?.length ?? 0;
  out.policyCheckFiles = c.policyCheckFiles?.length ?? 0;
  out.constructFiles = c.constructFiles?.length ?? 0;
  out.constructFacetFiles = c.constructFacetFiles?.length ?? 0;
  out.playbookFiles = c.playbookFiles?.length ?? 0;
  return out;
}

interface IPackageScanEntry {
  packageRoot: string;
  packageJsonPath: string;
}

/**
 * Yield every package.json under node_modules (top-level + first-level
 * @scope/* entries). Skips the .bin / .cache / .pnpm-style internals and
 * common nested node_modules to avoid recursion blow-up.
 */
function* scanNodeModules(nodeModulesPath: string): Iterable<IPackageScanEntry> {
  let entries;
  try {
    entries = readdirSync(nodeModulesPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const name = String(entry.name);
    if (name.startsWith('.')) continue;
    if (name === 'node_modules') continue;
    const dir = nodePath.join(nodeModulesPath, name);
    let isDir = false;
    try {
      isDir = entry.isDirectory() || entry.isSymbolicLink();
    } catch {
      isDir = false;
    }
    if (!isDir) continue;
    if (name.startsWith('@')) {
      // Scoped package directory: recurse one level.
      let scoped;
      try {
        scoped = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const scopedEntry of scoped) {
        const scopedName = String(scopedEntry.name);
        if (scopedName.startsWith('.')) continue;
        const packageRoot = nodePath.join(dir, scopedName);
        const packageJsonPath = nodePath.join(packageRoot, 'package.json');
        if (existsSync(packageJsonPath)) {
          yield { packageRoot, packageJsonPath };
        }
      }
    } else {
      const packageJsonPath = nodePath.join(dir, 'package.json');
      if (existsSync(packageJsonPath)) {
        yield { packageRoot: dir, packageJsonPath };
      }
    }
  }
}

export interface DiscoverPacksOptions {
  /** Project root to look up node_modules in. Must be absolute. */
  projectRoot: string;
  /**
   * Optional secondary roots to also scan (e.g. for tests that drop a pack
   * outside node_modules). Each must contain a `node_modules` directory.
   */
  extraRoots?: readonly string[];
  /** When true, surfaces detailed warnings even for "no manifest" packages. */
  verbose?: boolean;
  /**
   * If true, every signed pack is verified against the SHARKCRAFT_PACK_SECRET
   * env var (or {@link DiscoverPacksOptions.packSecret}). Unsigned packs are
   * not penalized — verification is opt-in.
   */
  verifySignatures?: boolean;
  /** Override the secret used for signature verification. */
  packSecret?: string;
  /**
   * Skip the process-level discovery cache. The cache is keyed by
   * projectRoot + lockfile mtime, so installs/upgrades invalidate it
   * automatically. Pass `noCache: true` to force a fresh scan (e.g.
   * after editing a manifest in place during a long-running process).
   */
  noCache?: boolean;
}

// Process-level cache keyed by (projectRoot + lockfile fingerprint).
// `discoverPacks` walks node_modules and reads every package.json,
// which is the slowest single step of `inspectSharkcraft()` on large
// monorepos. The cache is invalidated by lockfile mtime, so any
// install/uninstall/upgrade causes a fresh scan automatically.
//
// Bypassed when:
//   - `verifySignatures: true` is set (security-sensitive: always re-verify)
//   - `extraRoots` is non-empty (tests sometimes drop packs outside node_modules)
//   - `noCache: true` is passed (escape hatch)
interface ICacheKey {
  projectRoot: string;
  lockFingerprint: string;
}

const discoveryCache = new Map<string, IPackDiscoveryResult>();

function lockFingerprintFor(projectRoot: string): string {
  // Try each known lock file in order; first existing one wins. mtimeMs
  // changes every install, so it's a tight invalidation signal.
  const candidates = ['bun.lockb', 'bun.lock', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];
  for (const name of candidates) {
    const p = nodePath.join(projectRoot, name);
    if (existsSync(p)) {
      try {
        const st = statSync(p);
        return `${name}:${st.mtimeMs}:${st.size}`;
      } catch {
        // fall through and try the next candidate
      }
    }
  }
  // No lock file — also cache by node_modules mtime as a fallback.
  const nm = nodePath.join(projectRoot, 'node_modules');
  if (existsSync(nm)) {
    try {
      const st = statSync(nm);
      return `node_modules:${st.mtimeMs}`;
    } catch {
      // ignore
    }
  }
  return 'none';
}

function cacheKeyOf(key: ICacheKey): string {
  return `${key.projectRoot}::${key.lockFingerprint}`;
}

/** Clear the process-level pack-discovery cache. Tests use this. */
export function clearPackDiscoveryCache(): void {
  discoveryCache.clear();
}

/**
 * Walk `<projectRoot>/node_modules/` (+ any extra roots) and surface every
 * package whose `package.json` declares a `sharkcraft` field. For each, load
 * the manifest and run validatePackManifest. Returns a structured discovery
 * result; never throws on individual pack failures.
 *
 * The result is cached at process-level keyed by projectRoot + lock-file
 * mtime, so repeated calls within a single CLI invocation (or MCP server
 * session) skip the node_modules walk. The cache invalidates automatically
 * on any install/upgrade and is bypassed entirely when signature
 * verification is requested or extra roots are supplied.
 */
export async function discoverPacks(options: DiscoverPacksOptions): Promise<IPackDiscoveryResult> {
  const projectRoot = nodePath.resolve(options.projectRoot);
  const nodeModulesPath = nodePath.join(projectRoot, 'node_modules');
  const nodeModulesExists = existsSync(nodeModulesPath);

  // Cache lookup — only when the caller doesn't disable it AND when no
  // signature-verification or extra-root option might change the answer.
  const cacheable =
    !options.noCache &&
    !options.verifySignatures &&
    (!options.extraRoots || options.extraRoots.length === 0);
  const cacheKey = cacheable
    ? cacheKeyOf({ projectRoot, lockFingerprint: lockFingerprintFor(projectRoot) })
    : null;
  if (cacheKey) {
    const cached = discoveryCache.get(cacheKey);
    if (cached) return cached;
  }

  const result: IPackDiscoveryResult = {
    projectRoot,
    nodeModulesPath,
    nodeModulesExists,
    scannedPackageCount: 0,
    discoveredPacks: [],
    validPacks: [],
    invalidPacks: [],
    warnings: [],
  };

  const roots = [
    ...(nodeModulesExists ? [nodeModulesPath] : []),
    ...(options.extraRoots ?? []).map((r) => nodePath.resolve(r)),
  ];
  if (roots.length === 0) {
    result.warnings.push(`No node_modules at ${nodeModulesPath} and no extra roots provided.`);
    return result;
  }

  const seenPackagePaths = new Set<string>();
  for (const root of roots) {
    for (const { packageRoot, packageJsonPath } of scanNodeModules(root)) {
      // Dedup by realpath so workspace symlinks aren't visited twice.
      let canonical = packageRoot;
      try {
        canonical = realpathSync(packageRoot);
      } catch {
        // ignore — use the original path
      }
      if (seenPackagePaths.has(canonical)) continue;
      seenPackagePaths.add(canonical);
      result.scannedPackageCount += 1;

      const pkg = readPackageJson(packageJsonPath);
      if (!pkg) continue;
      if (pkg.sharkcraft === undefined) continue;

      const manifestPath = resolveManifestPath(packageRoot, pkg.sharkcraft);
      const packageName = pkg.name ?? '<unnamed>';
      const packageVersion = pkg.version ?? '0.0.0';

      const discovered: IDiscoveredPack = {
        packageName,
        packageVersion,
        manifestPath: manifestPath ?? '',
        packageRoot,
        contributionCounts: emptyCounts(),
        validationIssues: [],
        valid: false,
      };

      if (!manifestPath) {
        discovered.loadError = 'manifest path could not be resolved from package.json';
        result.discoveredPacks.push(discovered);
        result.invalidPacks.push(discovered);
        continue;
      }
      if (!existsSync(manifestPath)) {
        discovered.loadError = `manifest file does not exist: ${manifestPath}`;
        result.discoveredPacks.push(discovered);
        result.invalidPacks.push(discovered);
        continue;
      }

      try {
        let manifest: ISharkCraftPackManifest | undefined;
        if (manifestPath.endsWith('.json')) {
          // Signed JSON manifest path. Never dynamic-import — JSON is data, not
          // code, and treating it as code defeats the point of signing.
          const raw = readFileSync(manifestPath, 'utf8');
          manifest = JSON.parse(raw) as ISharkCraftPackManifest;
        } else {
          const mod = (await import(pathToFileURL(manifestPath).href)) as {
            default?: ISharkCraftPackManifest;
          };
          manifest = (mod.default ?? (mod as unknown as ISharkCraftPackManifest)) as
            | ISharkCraftPackManifest
            | undefined;
        }
        if (!manifest) {
          discovered.loadError = 'manifest module has no default export';
        } else {
          discovered.manifest = manifest;
          discovered.contributionCounts = countContributions(manifest.contributions);
          const v = validatePackManifest(manifest);
          discovered.validationIssues = v.issues;
          discovered.valid = v.valid;

          if (options.verifySignatures) {
            const verifyResult = verifyPackManifest(manifest, { secret: options.packSecret });
            discovered.signatureStatus = verifyResult.ok ? 'verified' : verifyResult.status;
            discovered.signatureMessage = verifyResult.ok
              ? 'Signature verified.'
              : verifyResult.message;
            if (!verifyResult.ok && verifyResult.status === 'invalid-signature') {
              // Tampered manifest — strip validity.
              discovered.valid = false;
              discovered.validationIssues.push({
                field: 'signature',
                message: 'Signature does not match — pack may have been tampered with.',
              });
            }
          } else if (manifest.signature) {
            discovered.signatureStatus = 'not-checked';
            discovered.signatureMessage = `Signed but not verified. Set ${PACK_SECRET_ENV} and run packs verify.`;
          }
        }
      } catch (e) {
        discovered.loadError = `failed to import manifest: ${(e as Error).message}`;
      }

      result.discoveredPacks.push(discovered);
      if (discovered.valid) result.validPacks.push(discovered);
      else result.invalidPacks.push(discovered);

      if (!discovered.valid && options.verbose) {
        result.warnings.push(
          `pack ${packageName}@${packageVersion} invalid: ${
            discovered.loadError ?? discovered.validationIssues.map((i) => i.field).join(', ')
          }`,
        );
      }
    }
  }

  if (cacheKey) {
    discoveryCache.set(cacheKey, result);
  }
  return result;
}
