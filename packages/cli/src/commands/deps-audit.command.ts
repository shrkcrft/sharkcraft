import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import { GraphQueryApi, GraphStore, NodeKind } from '@shrkcrft/graph';
import {
  flagBool,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header } from '../output/format-output.ts';

interface IDeclaredDeps {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
}

interface IPackageReport {
  packageName: string;
  packageDir: string;
  declared: IDeclaredDeps;
  importedSpecifiers: string[];
  missingDeps: Array<{ specifier: string; importedFromCount: number }>;
  unusedDeps: Array<{ specifier: string; section: string }>;
}

/**
 * `shrk deps-audit` — for each workspace package, compare the
 * `package.json` `dependencies` / `devDependencies` / `peerDependencies`
 * against the *specifiers actually imported* from source under
 * `<pkg>/src/` (per the SharkCraft graph).
 *
 * Reports:
 *   - missing deps: imported but not declared (likely build failure
 *     in the wild — the package depends on its host's resolution)
 *   - unused deps: declared but never imported (lint waste)
 *
 * Read-only. JSON output via `--json`. Optionally restricted to one
 * package via `--package <name>`.
 *
 * Known limitations:
 *   - Type-only imports (`import type x from 'y'`) still count; the
 *     graph can't tell them apart in v3.
 *   - Subpath imports (`pkg/sub`) are reduced to their root specifier.
 *   - Built-in node modules (`node:fs`, `fs`, …) are ignored.
 */
export const depsAuditCommand: ICommandHandler = {
  name: 'deps-audit',
  description:
    'Audit declared dependencies vs imports actually seen in each package source. Reports missing + unused deps. Read-only.',
  usage: 'shrk deps-audit [--package <name>] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const json = flagBool(args, 'json');
    const onlyPackage = typeof args.flags.get('package') === 'string'
      ? (args.flags.get('package') as string)
      : null;

    const store = new GraphStore(cwd);
    if (!store.exists()) {
      process.stderr.write(
        'No SharkCraft graph found. Run `shrk graph index` first so deps-audit has import data.\n',
      );
      return 1;
    }
    const api = GraphQueryApi.fromStore(cwd);

    const packages = listWorkspacePackages(cwd, onlyPackage);
    if (packages.length === 0) {
      process.stderr.write('No packages found (looked under packages/*, libs/*, apps/*).\n');
      return 1;
    }

    const reports: IPackageReport[] = [];
    for (const pkg of packages) {
      reports.push(buildPackageReport(api, cwd, pkg));
    }

    if (json) {
      process.stdout.write(asJson({ packages: reports }) + '\n');
      return 0;
    }

    let missingTotal = 0;
    let unusedTotal = 0;
    for (const r of reports) {
      missingTotal += r.missingDeps.length;
      unusedTotal += r.unusedDeps.length;
    }
    process.stdout.write(
      header(`deps-audit — ${reports.length} package(s), ${missingTotal} missing dep(s), ${unusedTotal} unused dep(s)`),
    );
    for (const r of reports) {
      if (r.missingDeps.length === 0 && r.unusedDeps.length === 0) continue;
      process.stdout.write(`\n${r.packageName} (${r.packageDir})\n`);
      if (r.missingDeps.length > 0) {
        process.stdout.write('  missing (imported, not declared):\n');
        for (const m of r.missingDeps) {
          process.stdout.write(`    - ${m.specifier} (imported ${m.importedFromCount}×)\n`);
        }
      }
      if (r.unusedDeps.length > 0) {
        process.stdout.write('  unused (declared, never imported):\n');
        for (const u of r.unusedDeps) {
          process.stdout.write(`    - ${u.specifier}  [${u.section}]\n`);
        }
      }
    }
    if (missingTotal === 0 && unusedTotal === 0) {
      process.stdout.write('\nAll declared deps match actual imports. ✓\n');
    }
    return 0;
  },
};

interface IWorkspacePackage {
  name: string;
  dir: string;
  pkgJsonPath: string;
}

function listWorkspacePackages(cwd: string, onlyName: string | null): IWorkspacePackage[] {
  const roots = ['packages', 'libs', 'apps'].map((r) => nodePath.join(cwd, r)).filter((d) => existsSync(d));
  const out: IWorkspacePackage[] = [];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const dir = nodePath.join(root, entry);
      let stat;
      try {
        stat = statSync(dir);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      const pkgJsonPath = nodePath.join(dir, 'package.json');
      if (!existsSync(pkgJsonPath)) continue;
      let pkgJson: { name?: string };
      try {
        pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { name?: string };
      } catch {
        continue;
      }
      if (!pkgJson.name) continue;
      if (onlyName !== null && pkgJson.name !== onlyName) continue;
      out.push({ name: pkgJson.name, dir, pkgJsonPath });
    }
  }
  return out;
}

function buildPackageReport(api: GraphQueryApi, cwd: string, pkg: IWorkspacePackage): IPackageReport {
  const declared = readDeclaredDeps(pkg.pkgJsonPath);
  const importedSpecifiers = collectImportedSpecifiersForPackage(api, cwd, pkg.dir);

  // Count how many distinct files inside the package import each specifier.
  const importerCounts = new Map<string, number>();
  for (const spec of importedSpecifiers) {
    importerCounts.set(spec, (importerCounts.get(spec) ?? 0) + 1);
  }
  const distinctImported = new Set(importedSpecifiers);

  const declaredAll = new Map<string, string>();
  const declaredSections = [
    ['dependencies', declared.dependencies],
    ['devDependencies', declared.devDependencies],
    ['peerDependencies', declared.peerDependencies],
    ['optionalDependencies', declared.optionalDependencies],
  ] as const;
  for (const [section, map] of declaredSections) {
    for (const k of Object.keys(map)) declaredAll.set(k, section);
  }

  const missingDeps: IPackageReport['missingDeps'] = [];
  for (const spec of distinctImported) {
    if (declaredAll.has(spec)) continue;
    if (spec === pkg.name) continue; // self-import via package name
    missingDeps.push({ specifier: spec, importedFromCount: importerCounts.get(spec) ?? 0 });
  }
  missingDeps.sort((a, b) => b.importedFromCount - a.importedFromCount);

  const unusedDeps: IPackageReport['unusedDeps'] = [];
  for (const [spec, section] of declaredAll.entries()) {
    if (distinctImported.has(spec)) continue;
    // devDependencies for build/test tools often don't show up in graph
    // imports; we still report them so the user can prune if desired.
    unusedDeps.push({ specifier: spec, section });
  }
  unusedDeps.sort((a, b) => a.specifier.localeCompare(b.specifier));

  return {
    packageName: pkg.name,
    packageDir: nodePath.relative(cwd, pkg.dir) || '.',
    declared,
    importedSpecifiers: [...distinctImported],
    missingDeps,
    unusedDeps,
  };
}

function readDeclaredDeps(pkgJsonPath: string): IDeclaredDeps {
  try {
    const body = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as Record<string, unknown>;
    return {
      dependencies: asStringMap(body['dependencies']),
      devDependencies: asStringMap(body['devDependencies']),
      peerDependencies: asStringMap(body['peerDependencies']),
      optionalDependencies: asStringMap(body['optionalDependencies']),
    };
  } catch {
    return { dependencies: {}, devDependencies: {}, peerDependencies: {}, optionalDependencies: {} };
  }
}

function asStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

function collectImportedSpecifiersForPackage(
  api: GraphQueryApi,
  cwd: string,
  packageDir: string,
): string[] {
  const out: string[] = [];
  const relDir = nodePath.relative(cwd, packageDir).replace(/\\/g, '/');
  for (const file of api.allFiles()) {
    if (file.kind !== NodeKind.File) continue;
    const p = file.path ?? '';
    if (!p.startsWith(relDir + '/src/') && !p.startsWith(relDir + '/')) continue;
    // Each ImportsFile edge resolves to a file node; we want the *raw*
    // import specifier, which the graph carries on the edge's data
    // payload. We don't have direct access here, so we approximate by
    // reading the file contents and extracting from-clauses.
    const abs = nodePath.isAbsolute(p) ? p : nodePath.join(cwd, p);
    if (!existsSync(abs)) continue;
    let body: string;
    try {
      body = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    for (const spec of extractRootSpecifiers(body)) {
      if (isBuiltinModule(spec)) continue;
      if (spec.startsWith('.') || spec.startsWith('/')) continue; // relative
      out.push(rootOfSpecifier(spec));
    }
  }
  return out;
}

const IMPORT_FROM_RE = /(?:^|\n)\s*(?:import|export)\s+[^;]*?\s+from\s+['"]([^'"]+)['"]/g;
const REQUIRE_RE = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function extractRootSpecifiers(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(IMPORT_FROM_RE)) {
    if (m[1]) out.push(m[1]);
  }
  for (const m of body.matchAll(REQUIRE_RE)) {
    if (m[1]) out.push(m[1]);
  }
  for (const m of body.matchAll(DYNAMIC_IMPORT_RE)) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

function rootOfSpecifier(spec: string): string {
  if (spec.startsWith('@')) {
    const parts = spec.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : spec;
  }
  return spec.split('/')[0]!;
}

function isBuiltinModule(spec: string): boolean {
  if (spec.startsWith('node:')) return true;
  // Bun runtime builtins (`bun:test`, `bun:sqlite`, `bun:ffi`, …) are provided by
  // the runtime, never an npm dependency — so they are not "missing".
  if (spec.startsWith('bun:')) return true;
  // Common bare-name builtins.
  return new Set([
    'fs', 'path', 'os', 'crypto', 'http', 'https', 'url', 'util', 'stream',
    'events', 'child_process', 'process', 'buffer', 'querystring', 'zlib',
    'tls', 'net', 'dns', 'dgram', 'cluster', 'worker_threads', 'perf_hooks',
    'readline', 'tty', 'vm',
  ]).has(spec);
}
