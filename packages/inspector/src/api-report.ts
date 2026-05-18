/**
 * Public API / package API report.
 *
 * For each @shrkcrft/* package, surface: name, version, main, types,
 * exports, bin, README presence, deprecated re-exports if detectable.
 *
 * Read-only — just reads package.json + index files.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const API_REPORT_SCHEMA = 'sharkcraft.api-report/v1';

export interface IPackageApiEntry {
  name: string;
  version: string;
  packageRoot: string;
  hasReadme: boolean;
  main?: string;
  types?: string;
  bin?: Record<string, string>;
  exports?: Record<string, unknown>;
  deprecatedReexports: readonly string[];
  exportedSymbols: readonly string[];
  notes: readonly string[];
}

export interface IApiReport {
  schema: typeof API_REPORT_SCHEMA;
  generatedAt: string;
  packages: readonly IPackageApiEntry[];
}

function readPkg(dir: string): { meta: Record<string, unknown> | null; root: string } {
  const pkgJson = nodePath.join(dir, 'package.json');
  if (!existsSync(pkgJson)) return { meta: null, root: dir };
  try {
    return { meta: JSON.parse(readFileSync(pkgJson, 'utf8')) as Record<string, unknown>, root: dir };
  } catch {
    return { meta: null, root: dir };
  }
}

function listPackageDirs(projectRoot: string): readonly string[] {
  const packagesDir = nodePath.join(projectRoot, 'packages');
  if (!existsSync(packagesDir)) return [];
  const out: string[] = [];
  for (const d of readdirSync(packagesDir)) {
    const full = nodePath.join(packagesDir, d);
    try {
      if (statSync(full).isDirectory()) out.push(full);
    } catch {
      continue;
    }
  }
  return out;
}

function scanIndexExports(indexFile: string): readonly string[] {
  if (!existsSync(indexFile)) return [];
  try {
    const t = readFileSync(indexFile, 'utf8');
    const out = new Set<string>();
    const reExport = /export\s+(?:type\s+)?\*\s+from\s+['"]([^'"]+)['"]/g;
    const namedExport = /export\s+(?:type\s+)?\{([^}]+)\}\s+from/g;
    const inlineDecl = /export\s+(?:async\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z0-9_$]+)/g;
    let m: RegExpExecArray | null;
    while ((m = reExport.exec(t)) !== null) {
      const ref = m[1] ?? '';
      if (ref) out.add(`re-export:${ref}`);
    }
    while ((m = namedExport.exec(t)) !== null) {
      const body = m[1] ?? '';
      for (const sym of body.split(',').map((s) => s.trim().split(/\s+as\s+/)[0] ?? '')) {
        if (sym) out.add(sym);
      }
    }
    while ((m = inlineDecl.exec(t)) !== null) {
      const id = m[1] ?? '';
      if (id) out.add(id);
    }
    return [...out];
  } catch {
    return [];
  }
}

function detectDeprecated(indexFile: string): readonly string[] {
  if (!existsSync(indexFile)) return [];
  try {
    const t = readFileSync(indexFile, 'utf8');
    const out: string[] = [];
    const re = /@deprecated\s+([^\n]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t)) !== null) out.push((m[1] ?? '').trim());
    return out;
  } catch {
    return [];
  }
}

export interface IApiDiffEntry {
  package: string;
  added: readonly string[];
  removed: readonly string[];
  /** package metadata changes (version, bin, types, etc.) */
  metadataChanges: readonly { field: string; from: unknown; to: unknown }[];
  /** Symbols that look like breaking-change suspects (removed from a public surface). */
  breakingSuspects: readonly string[];
}

export interface IApiDiffReport {
  schema: 'sharkcraft.api-report-diff/v1';
  generatedAt: string;
  oldGeneratedAt?: string;
  newGeneratedAt: string;
  addedPackages: readonly string[];
  removedPackages: readonly string[];
  entries: readonly IApiDiffEntry[];
  /** delta of total public-surface size across all packages. */
  publicSurfaceDelta: number;
}

export function diffApiReports(oldReport: IApiReport, newReport: IApiReport): IApiDiffReport {
  const oldByName = new Map(oldReport.packages.map((p) => [p.name, p]));
  const newByName = new Map(newReport.packages.map((p) => [p.name, p]));
  const addedPackages: string[] = [];
  const removedPackages: string[] = [];
  for (const name of newByName.keys()) if (!oldByName.has(name)) addedPackages.push(name);
  for (const name of oldByName.keys()) if (!newByName.has(name)) removedPackages.push(name);
  const entries: IApiDiffEntry[] = [];
  let oldSize = 0;
  let newSize = 0;
  for (const p of oldReport.packages) oldSize += p.exportedSymbols.length;
  for (const p of newReport.packages) newSize += p.exportedSymbols.length;
  for (const [name, newPkg] of newByName.entries()) {
    const oldPkg = oldByName.get(name);
    if (!oldPkg) {
      // newly added package
      entries.push({
        package: name,
        added: newPkg.exportedSymbols,
        removed: [],
        metadataChanges: [],
        breakingSuspects: [],
      });
      continue;
    }
    const oldSet = new Set(oldPkg.exportedSymbols);
    const newSet = new Set(newPkg.exportedSymbols);
    const added = [...newSet].filter((s) => !oldSet.has(s));
    const removed = [...oldSet].filter((s) => !newSet.has(s));
    const metadataChanges: { field: string; from: unknown; to: unknown }[] = [];
    if (oldPkg.version !== newPkg.version)
      metadataChanges.push({ field: 'version', from: oldPkg.version, to: newPkg.version });
    if (JSON.stringify(oldPkg.bin ?? {}) !== JSON.stringify(newPkg.bin ?? {}))
      metadataChanges.push({ field: 'bin', from: oldPkg.bin ?? {}, to: newPkg.bin ?? {} });
    if ((oldPkg.types ?? '') !== (newPkg.types ?? ''))
      metadataChanges.push({ field: 'types', from: oldPkg.types ?? '', to: newPkg.types ?? '' });
    if ((oldPkg.main ?? '') !== (newPkg.main ?? ''))
      metadataChanges.push({ field: 'main', from: oldPkg.main ?? '', to: newPkg.main ?? '' });
    const breakingSuspects = removed.filter(
      (sym) => !sym.startsWith('re-export:') && !sym.startsWith('_'),
    );
    if (added.length === 0 && removed.length === 0 && metadataChanges.length === 0) continue;
    entries.push({ package: name, added, removed, metadataChanges, breakingSuspects });
  }
  return {
    schema: 'sharkcraft.api-report-diff/v1',
    generatedAt: new Date().toISOString(),
    ...(oldReport.generatedAt ? { oldGeneratedAt: oldReport.generatedAt } : {}),
    newGeneratedAt: newReport.generatedAt,
    addedPackages,
    removedPackages,
    entries,
    publicSurfaceDelta: newSize - oldSize,
  };
}

export function renderApiDiffMarkdown(diff: IApiDiffReport): string {
  const lines: string[] = [];
  lines.push('# API report diff');
  lines.push('');
  lines.push(`- public surface delta: **${diff.publicSurfaceDelta >= 0 ? '+' : ''}${diff.publicSurfaceDelta}**`);
  if (diff.addedPackages.length > 0) lines.push(`- packages added: ${diff.addedPackages.join(', ')}`);
  if (diff.removedPackages.length > 0) lines.push(`- packages removed: ${diff.removedPackages.join(', ')}`);
  for (const e of diff.entries) {
    lines.push('');
    lines.push(`## ${e.package}`);
    if (e.added.length > 0) {
      lines.push('### Added');
      for (const s of e.added) lines.push(`- \`${s}\``);
    }
    if (e.removed.length > 0) {
      lines.push('### Removed');
      for (const s of e.removed) lines.push(`- \`${s}\``);
    }
    if (e.metadataChanges.length > 0) {
      lines.push('### Metadata');
      for (const m of e.metadataChanges)
        lines.push(`- \`${m.field}\`: \`${JSON.stringify(m.from)}\` → \`${JSON.stringify(m.to)}\``);
    }
    if (e.breakingSuspects.length > 0) {
      lines.push('### Breaking-change suspects');
      for (const s of e.breakingSuspects) lines.push(`- \`${s}\``);
    }
  }
  return lines.join('\n') + '\n';
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderApiDiffHtml(diff: IApiDiffReport): string {
  const body: string[] = [];
  body.push('<h1>API report diff</h1>');
  body.push(`<p>Public surface delta: <strong>${diff.publicSurfaceDelta}</strong></p>`);
  if (diff.addedPackages.length > 0) body.push(`<p>Added: ${escapeHtml(diff.addedPackages.join(', '))}</p>`);
  if (diff.removedPackages.length > 0) body.push(`<p>Removed: ${escapeHtml(diff.removedPackages.join(', '))}</p>`);
  for (const e of diff.entries) {
    body.push(`<h2>${escapeHtml(e.package)}</h2>`);
    if (e.added.length > 0)
      body.push('<p>Added: ' + e.added.map((s) => `<code>${escapeHtml(s)}</code>`).join(', ') + '</p>');
    if (e.removed.length > 0)
      body.push('<p>Removed: ' + e.removed.map((s) => `<code>${escapeHtml(s)}</code>`).join(', ') + '</p>');
    if (e.breakingSuspects.length > 0)
      body.push('<p>Breaking-change suspects: ' + e.breakingSuspects.map((s) => `<code>${escapeHtml(s)}</code>`).join(', ') + '</p>');
  }
  return `<!doctype html><meta charset="utf-8"><title>API diff</title>${body.join('\n')}`;
}

export function buildApiReport(
  inspection: ISharkcraftInspection,
  options: { packageFilter?: string } = {},
): IApiReport {
  const dirs = listPackageDirs(inspection.projectRoot);
  const packages: IPackageApiEntry[] = [];
  for (const dir of dirs) {
    const { meta } = readPkg(dir);
    if (!meta) continue;
    const name = String(meta.name ?? '');
    if (options.packageFilter && name !== options.packageFilter) continue;
    const version = String(meta.version ?? '0.0.0');
    const main = typeof meta.main === 'string' ? (meta.main as string) : undefined;
    const types = typeof meta.types === 'string' ? (meta.types as string) : undefined;
    const bin = meta.bin && typeof meta.bin === 'object' ? (meta.bin as Record<string, string>) : undefined;
    const exportsField = meta.exports && typeof meta.exports === 'object' ? (meta.exports as Record<string, unknown>) : undefined;
    const indexCandidates = [
      main && nodePath.resolve(dir, main),
      nodePath.resolve(dir, 'src/index.ts'),
      nodePath.resolve(dir, 'src/main.ts'),
    ].filter((s): s is string => typeof s === 'string');
    const indexFile = indexCandidates.find((f) => existsSync(f)) ?? indexCandidates[0];
    const exportedSymbols = indexFile ? scanIndexExports(indexFile) : [];
    const deprecatedReexports = indexFile ? detectDeprecated(indexFile) : [];
    const readmeAbs = nodePath.join(dir, 'README.md');
    const notes: string[] = [];
    if (!existsSync(readmeAbs)) notes.push('README.md missing.');
    if (!indexFile) notes.push('No src/index.ts entry detected.');
    packages.push({
      name,
      version,
      packageRoot: dir,
      hasReadme: existsSync(readmeAbs),
      ...(main ? { main } : {}),
      ...(types ? { types } : {}),
      ...(bin ? { bin } : {}),
      ...(exportsField ? { exports: exportsField } : {}),
      exportedSymbols,
      deprecatedReexports,
      notes,
    });
  }
  return {
    schema: API_REPORT_SCHEMA,
    generatedAt: new Date().toISOString(),
    packages,
  };
}
