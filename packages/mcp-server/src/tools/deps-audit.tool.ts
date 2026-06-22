import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import { GraphQueryApi, GraphStore, NodeKind, loadGraphApiCached } from '@shrkcrft/graph';
import type { IToolDefinition } from '../server/tool-definition.ts';
import { FORMAT_INPUT_PROPERTY, formatObjectArrays, COLUMNAR_LEGEND } from '../server/columnar-format.ts';
import { fitArrayToBudget } from '../server/fit-array-to-budget.ts';

/**
 * `deps_audit` — MCP wrapper around `shrk deps-audit`. Pure read-only.
 * Returns the same shape the CLI's `--json` mode emits.
 *
 * NOTE: we re-implement the body here rather than shell out so MCP
 * tools never spawn subprocesses. Identical logic, identical output.
 */
export const depsAuditTool: IToolDefinition = {
  name: 'deps_audit',
  description:
    'Per-package audit of declared dependencies (package.json) vs actually-imported specifiers (graph). Reports missing + unused deps. Pass `format:"table"` for a token-efficient columnar encoding of the per-package report list. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      package: { type: 'string' },
      ...FORMAT_INPUT_PROPERTY,
      maxTokens: {
        type: 'integer',
        minimum: 1,
        description:
          'Token budget for the per-package report list. When set and the columnar form still exceeds it, falls back to the lossy SmartCrusher row-sampler (full original cached — retrieve via the returned ccrKey).',
      },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const onlyPackage = typeof input['package'] === 'string' ? (input['package'] as string) : null;
    const store = new GraphStore(ctx.cwd);
    if (!store.exists()) {
      return {
        data: {
          error: 'no-graph',
          message: 'The SharkCraft graph index is required for deps-audit.',
          nextCommand: 'shrk graph index',
        },
      };
    }
    const api = loadGraphApiCached(ctx.cwd) ?? GraphQueryApi.fromStore(ctx.cwd);
    const packages = listWorkspacePackages(ctx.cwd, onlyPackage);
    const reports = packages.map((p) => buildPackageReport(api, ctx.cwd, p));
    const totals = reports.reduce(
      (acc, r) => {
        acc.missing += r.missingDeps.length;
        acc.unused += r.unusedDeps.length;
        return acc;
      },
      { missing: 0, unused: 0 },
    );
    // P5.2: an explicit token budget routes the per-package report list through
    // the SmartCrusher row-sampler (lossy, CCR-recoverable) when even the
    // columnar form is over budget.
    const maxTokens =
      typeof input.maxTokens === 'number' && input.maxTokens > 0 ? Math.floor(input.maxTokens) : undefined;
    if (maxTokens) {
      const fitted = fitArrayToBudget(reports, maxTokens, ctx.ccrStore);
      return {
        data: {
          _format: 'table',
          _legend: COLUMNAR_LEGEND,
          totals,
          packages: fitted.value,
          ...(fitted.ccrKey
            ? { ccrKey: fitted.ccrKey, retrieveWith: `retrieve_original { "key": "${fitted.ccrKey}" }` }
            : {}),
        },
      };
    }
    // `format:"table"` columnar-encodes the homogeneous `packages` report
    // list; the `totals` scalar object is left untouched. The per-package
    // string arrays (importedSpecifiers/missingDeps/unusedDeps) ride along
    // inside each compacted row and reconstruct losslessly.
    return { data: formatObjectArrays({ totals, packages: reports }, input) };
  },
};

interface IDeclaredDeps {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
}

interface IPackageReport {
  packageName: string;
  packageDir: string;
  importedSpecifiers: string[];
  missingDeps: Array<{ specifier: string; importedFromCount: number }>;
  unusedDeps: Array<{ specifier: string; section: string }>;
}

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
  const importerCounts = new Map<string, number>();
  for (const s of importedSpecifiers) importerCounts.set(s, (importerCounts.get(s) ?? 0) + 1);
  const distinctImported = new Set(importedSpecifiers);
  const declaredAll = new Map<string, string>();
  for (const [section, map] of [
    ['dependencies', declared.dependencies],
    ['devDependencies', declared.devDependencies],
    ['peerDependencies', declared.peerDependencies],
    ['optionalDependencies', declared.optionalDependencies],
  ] as const) {
    for (const k of Object.keys(map)) declaredAll.set(k, section);
  }
  const missingDeps: IPackageReport['missingDeps'] = [];
  for (const spec of distinctImported) {
    if (declaredAll.has(spec)) continue;
    if (spec === pkg.name) continue;
    missingDeps.push({ specifier: spec, importedFromCount: importerCounts.get(spec) ?? 0 });
  }
  missingDeps.sort((a, b) => b.importedFromCount - a.importedFromCount);
  const unusedDeps: IPackageReport['unusedDeps'] = [];
  for (const [spec, section] of declaredAll.entries()) {
    if (distinctImported.has(spec)) continue;
    unusedDeps.push({ specifier: spec, section });
  }
  unusedDeps.sort((a, b) => a.specifier.localeCompare(b.specifier));
  return {
    packageName: pkg.name,
    packageDir: nodePath.relative(cwd, pkg.dir) || '.',
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
      if (spec.startsWith('.') || spec.startsWith('/')) continue;
      out.push(rootOfSpecifier(spec));
    }
  }
  return out;
}

const IMPORT_FROM_RE = /(?:^|\n)\s*(?:import|export)\s+[^;]*?\s+from\s+['"]([^'"]+)['"]/g;
const REQUIRE_RE = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;
// `await import('pkg')` / `import('pkg')` — bare dynamic imports.
// Note: we intentionally match `\bimport\s*\(` not just `import(` so we
// don't false-trigger on `LocaleImport(...)` etc.
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
  // Bun runtime builtins (`bun:test`, `bun:sqlite`, …) are runtime-provided,
  // never an npm dependency — so they are not "missing".
  if (spec.startsWith('bun:')) return true;
  return new Set([
    'fs', 'path', 'os', 'crypto', 'http', 'https', 'url', 'util', 'stream',
    'events', 'child_process', 'process', 'buffer', 'querystring', 'zlib',
    'tls', 'net', 'dns', 'dgram', 'cluster', 'worker_threads', 'perf_hooks',
    'readline', 'tty', 'vm',
  ]).has(spec);
}
