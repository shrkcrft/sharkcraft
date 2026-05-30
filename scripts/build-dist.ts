#!/usr/bin/env bun
// Build script: emits compiled JS + declaration files into packages/<name>/dist/.
//
// Strategy:
//   1. Topologically sort packages by their @shrkcrft/* workspace deps.
//   2. For each package, write a fresh tsconfig.build.json that:
//        - extends the repo-level tsconfig.publish.json (no @shrkcrft/* paths)
//        - sets rootDir = ./src, outDir = ./dist
//        - sets paths so cross-package imports of @shrkcrft/<dep> resolve to
//          ../<dep>/dist/index.d.ts (already built thanks to topo order)
//   3. Run tsc per package. TypeScript 5.7+ rewrites relative .ts imports to
//      .js on emit so the dist tree is consumable by Node and Bun.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const PACKAGES_DIR = join(ROOT, 'packages');

interface IPackageMeta {
  dir: string;
  name: string; // @shrkcrft/<short>
  short: string; // short (core, cli, ...)
  deps: string[]; // short names of @shrkcrft/* deps
}

function readJson<T>(p: string): T {
  return JSON.parse(readFileSync(p, 'utf8')) as T;
}

function discoverPackages(): IPackageMeta[] {
  const out: IPackageMeta[] = [];
  for (const short of readdirSync(PACKAGES_DIR)) {
    const dir = join(PACKAGES_DIR, short);
    if (!statSync(dir).isDirectory()) continue;
    const pkgJson = join(dir, 'package.json');
    if (!existsSync(pkgJson)) continue;
    const meta = readJson<{ name: string; private?: boolean; dependencies?: Record<string, string> }>(pkgJson);
    // The dashboard package is a browser bundle built by Vite — skip the
    // per-package tsc emit step.
    if (short === 'dashboard') continue;
    if (meta.private) continue;
    const deps = Object.keys(meta.dependencies ?? {})
      .filter((d) => d.startsWith('@shrkcrft/'))
      .map((d) => d.slice('@shrkcrft/'.length))
      .filter((dep) => dep !== 'dashboard');
    out.push({ dir, name: meta.name, short, deps });
  }
  return out;
}

function topoSort(packages: IPackageMeta[]): IPackageMeta[] {
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

function writeBuildTsconfig(pkg: IPackageMeta): void {
  const paths: Record<string, string[]> = {};
  for (const dep of pkg.deps) {
    paths[`@shrkcrft/${dep}`] = [`../${dep}/dist/index.d.ts`];
  }
  const content = {
    extends: '../../tsconfig.publish.json',
    compilerOptions: {
      rootDir: './src',
      outDir: './dist',
      baseUrl: '.',
      paths,
      tsBuildInfoFile: './dist/.tsbuildinfo',
    },
    include: ['src/**/*.ts'],
    exclude: ['src/__tests__/**/*'],
  };
  writeFileSync(
    join(pkg.dir, 'tsconfig.build.json'),
    JSON.stringify(content, null, 2) + '\n',
    'utf8',
  );
}

/**
 * tsc with rewriteRelativeImportExtensions:true rewrites `.ts` → `.js` in
 * emitted .js but currently keeps `.ts` extensions in emitted .d.ts files.
 * Strip them so npm consumers can resolve declarations without the extension.
 */
function postprocessDts(distDir: string): void {
  const stack: string[] = [distDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.name.endsWith('.d.ts') && !entry.name.endsWith('.d.ts.map')) continue;
      const orig = readFileSync(full, 'utf8');
      // Rewrite `.ts` → `.js` in import/from/dynamic-import specifiers so
      // NodeNext-style resolution finds the sibling .d.ts file.
      const fixed = orig
        .replace(/(\bfrom\s+['"][^'"]+?)\.ts(['"])/g, '$1.js$2')
        .replace(/(\bimport\s*\(\s*['"][^'"]+?)\.ts(['"])/g, '$1.js$2');
      if (fixed !== orig) writeFileSync(full, fixed, 'utf8');
    }
  }
}

function buildPackage(pkg: IPackageMeta): boolean {
  const distDir = join(pkg.dir, 'dist');
  if (existsSync(distDir)) rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });
  writeBuildTsconfig(pkg);

  process.stdout.write(`[build-dist] ${pkg.short.padEnd(15)} (deps: ${pkg.deps.join(', ') || 'none'})\n`);

  const res = spawnSync('bun', ['x', 'tsc', '-p', join(pkg.dir, 'tsconfig.build.json')], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (res.status !== 0) {
    process.stderr.write(`[build-dist] FAILED ${pkg.short}\n`);
    return false;
  }
  if (!existsSync(join(distDir, 'index.js'))) {
    process.stderr.write(`[build-dist] ${pkg.short}: emit completed but dist/index.js missing\n`);
    return false;
  }
  postprocessDts(distDir);
  return true;
}

function buildDashboard(): boolean {
  const dashboardDir = join(PACKAGES_DIR, 'dashboard');
  if (!existsSync(join(dashboardDir, 'package.json'))) return true;
  const distDir = join(dashboardDir, 'dist');
  if (existsSync(distDir)) rmSync(distDir, { recursive: true, force: true });
  process.stdout.write(`[build-dist] ${'dashboard'.padEnd(15)} (vite)\n`);
  const res = spawnSync('bun', ['x', 'vite', 'build'], {
    cwd: dashboardDir,
    stdio: 'inherit',
  });
  if (res.status !== 0) {
    process.stderr.write('[build-dist] FAILED dashboard\n');
    return false;
  }
  if (!existsSync(join(distDir, 'index.html'))) {
    process.stderr.write(
      '[build-dist] dashboard: emit completed but dist/index.html missing\n',
    );
    return false;
  }
  return true;
}

const all = discoverPackages();
const ordered = topoSort(all);

let failed = 0;
for (const pkg of ordered) {
  if (!buildPackage(pkg)) {
    failed += 1;
  }
}

if (!buildDashboard()) {
  failed += 1;
}

// `tsc` emit drops the executable bit on bin entrypoints (npm restores it on
// publish from the `bin` field, but a local dist rebuild does not). Restore
// +x so the bin runs directly / via `bunx` without EACCES — otherwise bunx
// falls through to a registry lookup for the non-existent `shrk` package.
for (const pkg of ordered) {
  const pkgJsonPath = join(pkg.dir, 'package.json');
  if (!existsSync(pkgJsonPath)) continue;
  const bin = readJson<{ bin?: Record<string, string> | string }>(pkgJsonPath).bin;
  const binPaths = typeof bin === 'string' ? [bin] : bin ? Object.values(bin) : [];
  for (const rel of binPaths) {
    const abs = join(pkg.dir, rel);
    if (existsSync(abs)) chmodSync(abs, 0o755);
  }
}

process.stdout.write('\n[build-dist] summary\n---\n');
for (const pkg of ordered) {
  const dist = join(pkg.dir, 'dist');
  if (!existsSync(dist)) continue;
  const files = readdirSync(dist).filter((f) => !f.startsWith('.')).length;
  process.stdout.write(`  ${pkg.short.padEnd(15)} dist/ (${files} files)\n`);
}
const dashboardDist = join(PACKAGES_DIR, 'dashboard', 'dist');
if (existsSync(dashboardDist)) {
  const files = readdirSync(dashboardDist).filter((f) => !f.startsWith('.')).length;
  process.stdout.write(`  ${'dashboard'.padEnd(15)} dist/ (${files} files)\n`);
}

if (failed > 0) {
  process.stderr.write(`\n[build-dist] ${failed} package(s) failed.\n`);
  process.exit(1);
}
process.stdout.write('\n[build-dist] ok\n');
