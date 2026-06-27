// Shared publish-mode helpers. Used by:
//   - scripts/publish-dry-run.ts (tarball inspection)
//   - scripts/install-smoke-test.ts (fresh-install verification)
//   - scripts/publish-packages.ts (real npm publish)
//
// The transformation does three things to a package.json:
//   1. Rewrites main / types / exports / bin from ./src/<x>.ts → ./dist/<x>.{js|d.ts}.
//   2. Sets files: ["dist", "README.md", "LICENSE"] (override, not merge — we
//      do not want to ship src in production tarballs).
//   3. Replaces every internal "@shrkcrft/*": "workspace:*" pin with
//      "^<version>" using the version of that package.
//
// Backup + restore is the caller's responsibility — the `withPublishMode`
// helper handles it for them.
import {
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export interface IPackageJson {
  name: string;
  version: string;
  type?: string;
  main?: string;
  types?: string;
  exports?: unknown;
  bin?: unknown;
  files?: string[];
  publishConfig?: { access?: string; tag?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  private?: boolean;
  [k: string]: unknown;
}

export interface IPackageMeta {
  short: string;
  name: string;
  version: string;
  dir: string;
  deps: string[]; // short names of @shrkcrft/* deps
  private: boolean;
}

export function readJson<T>(p: string): T {
  return JSON.parse(readFileSync(p, 'utf8')) as T;
}

export function rewriteFile(s: string): string {
  return s.replace(/^\.\/src\//, './dist/').replace(/\.tsx?$/, '.js');
}

export function rewriteTypes(s: string): string {
  // Idempotent: a path already ending in .d.ts (dual-runtime package.json
  // shape) must only have its ./src/ prefix rebased, never re-suffixed —
  // otherwise the trailing .ts matches /\.tsx?$/ and we emit `.d.d.ts`.
  if (s.endsWith('.d.ts')) return s.replace(/^\.\/src\//, './dist/');
  return s.replace(/^\.\/src\//, './dist/').replace(/\.tsx?$/, '.d.ts');
}

function rewriteBin(bin: unknown): unknown {
  if (typeof bin === 'string') return rewriteFile(bin);
  if (bin && typeof bin === 'object') {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(bin as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = rewriteFile(v);
    }
    return out;
  }
  return bin;
}

/**
 * Pure transform: produce a publish-mode package.json from a dev-mode one.
 * Does not touch disk. Pass a `versionByName` map keyed by full `@scope/<name>`.
 */
export function buildPublishPkg(
  orig: IPackageJson,
  versionByName: ReadonlyMap<string, string>,
): IPackageJson {
  const out: IPackageJson = { ...orig };
  if (typeof orig.main === 'string') out.main = rewriteFile(orig.main);
  if (typeof orig.types === 'string') out.types = rewriteTypes(orig.types);
  if (orig.exports && typeof orig.exports === 'object') {
    const e = orig.exports as Record<string, unknown>;
    const fixed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(e)) {
      if (typeof v === 'string') {
        fixed[k] = {
          types: rewriteTypes(v),
          import: rewriteFile(v),
          default: rewriteFile(v),
        };
      } else {
        fixed[k] = v;
      }
    }
    out.exports = fixed;
  }
  if (orig.bin !== undefined) out.bin = rewriteBin(orig.bin);
  // Override (not merge) files: published packages must ship dist only.
  out.files = ['dist', 'README.md', 'LICENSE'];
  // Packages may opt into exact (no-caret) pinning for specific internal
  // deps by listing them under `publishPinExact`. This is the safe default
  // for thin re-export wrappers (e.g. `shrk` → `@shrkcrft/cli`) where any
  // version skew between wrapper and target breaks the contract.
  const pinExact = new Set<string>(
    Array.isArray((orig as { publishPinExact?: unknown }).publishPinExact)
      ? ((orig as { publishPinExact: string[] }).publishPinExact)
      : [],
  );
  // Concretize internal workspace pins.
  for (const block of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
    const deps = out[block] as Record<string, string> | undefined;
    if (!deps) continue;
    const next: Record<string, string> = {};
    for (const [dep, pin] of Object.entries(deps)) {
      if (
        dep.startsWith('@shrkcrft/') &&
        (pin === 'workspace:*' || pin === 'workspace:^')
      ) {
        const v = versionByName.get(dep);
        if (v) {
          next[dep] = pinExact.has(dep) ? v : `^${v}`;
        } else {
          next[dep] = pin;
        }
      } else {
        next[dep] = pin;
      }
    }
    out[block] = next;
  }
  // Strip our build-only metadata before publishing.
  delete (out as { publishPinExact?: unknown }).publishPinExact;
  return out;
}

/**
 * Wrap a side-effecting operation so the package.json is swapped to publish
 * mode for the duration of `fn`, then unconditionally restored — even if
 * `fn` throws.
 */
export async function withPublishMode<T>(
  pkgDir: string,
  versionByName: ReadonlyMap<string, string>,
  fn: () => Promise<T> | T,
): Promise<T> {
  const pkgPath = join(pkgDir, 'package.json');
  const backupPath = join(pkgDir, 'package.json.bak');
  const orig = readJson<IPackageJson>(pkgPath);
  const publish = buildPublishPkg(orig, versionByName);
  copyFileSync(pkgPath, backupPath);
  try {
    writeFileSync(pkgPath, JSON.stringify(publish, null, 2) + '\n', 'utf8');
    return await fn();
  } finally {
    copyFileSync(backupPath, pkgPath);
    unlinkSync(backupPath);
  }
}

/**
 * Swap every non-private package under `packagesDir` into publish mode for the
 * duration of `fn`, then unconditionally restore — even if `fn` throws.
 * Use this when an operation (e.g. running the built CLI under Node) needs
 * every workspace dep to resolve to dist/ rather than src/.
 */
export async function withAllPackagesPublishMode<T>(
  packagesDir: string,
  fn: () => Promise<T> | T,
  options: { skip?: readonly string[] } = {},
): Promise<T> {
  const skip = new Set(options.skip ?? []);
  const packages = discoverPackages(packagesDir);
  const vers = versionsByName(packages);
  const swapped: string[] = [];
  try {
    for (const p of packages) {
      if (p.private || skip.has(p.short)) continue;
      const pkgPath = join(p.dir, 'package.json');
      const backupPath = join(p.dir, 'package.json.bak');
      const orig = readJson<IPackageJson>(pkgPath);
      const publish = buildPublishPkg(orig, vers);
      copyFileSync(pkgPath, backupPath);
      writeFileSync(pkgPath, JSON.stringify(publish, null, 2) + '\n', 'utf8');
      swapped.push(p.dir);
    }
    return await fn();
  } finally {
    for (const dir of swapped) {
      const pkgPath = join(dir, 'package.json');
      const backupPath = join(dir, 'package.json.bak');
      try {
        copyFileSync(backupPath, pkgPath);
        unlinkSync(backupPath);
      } catch {
        // Best effort: don't throw from finally and mask the original error.
        process.stderr.write(`[publish-mode] failed to restore ${pkgPath}\n`);
      }
    }
  }
}

/**
 * Discover packages under packages/<short>. Skips `private: true`. Returns the
 * meta needed by both the publisher and the topo sorter.
 */
export function discoverPackages(packagesDir: string): IPackageMeta[] {
  const out: IPackageMeta[] = [];
  for (const short of readdirSync(packagesDir)) {
    const dir = join(packagesDir, short);
    if (!statSync(dir).isDirectory()) continue;
    const pkgJson = join(dir, 'package.json');
    if (!existsSync(pkgJson)) continue;
    const meta = readJson<IPackageJson>(pkgJson);
    const deps = [
      ...Object.keys(meta.dependencies ?? {}),
      ...Object.keys(meta.peerDependencies ?? {}),
    ]
      .filter((d) => d.startsWith('@shrkcrft/'))
      .map((d) => d.slice('@shrkcrft/'.length));
    out.push({
      short,
      name: meta.name,
      version: meta.version,
      dir,
      deps,
      private: meta.private === true,
    });
  }
  return out;
}

/**
 * Topological sort by internal `@shrkcrft/*` dependency edges. Leaves
 * (packages depending on nothing internal) come first; consumers come last.
 * Throws on cycles.
 */
export function topoSort(packages: IPackageMeta[]): IPackageMeta[] {
  const byShort = new Map(packages.map((p) => [p.short, p]));
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const result: IPackageMeta[] = [];
  function visit(short: string): void {
    if (visited.has(short)) return;
    if (inStack.has(short)) {
      throw new Error(`Cycle detected at package "${short}"`);
    }
    inStack.add(short);
    const pkg = byShort.get(short);
    if (!pkg) {
      inStack.delete(short);
      visited.add(short);
      return;
    }
    for (const dep of pkg.deps) visit(dep);
    inStack.delete(short);
    visited.add(short);
    result.push(pkg);
  }
  for (const p of packages) visit(p.short);
  return result;
}

export function versionsByName(packages: readonly IPackageMeta[]): Map<string, string> {
  return new Map(packages.map((p) => [p.name, p.version]));
}

/**
 * Resolve a user-supplied package identifier (either short name like "cli"
 * or full name like "@shrkcrft/cli") to the matching IPackageMeta.
 * Returns undefined when no match.
 */
export function matchPackage(
  packages: readonly IPackageMeta[],
  identifier: string,
): IPackageMeta | undefined {
  return packages.find((p) => p.short === identifier || p.name === identifier);
}
