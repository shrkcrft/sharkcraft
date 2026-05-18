/**
 * Plugin-api symbol compatibility diff.
 *
 * Reads `import { … } from '@shrkcrft/plugin-api'` lines from each pack
 * contribution file, resolves the consumer's installed plugin-api source,
 * and reports which symbols the pack uses that the consumer's plugin-api
 * does not export.
 *
 * This is intentionally a regex/structural parser — we do not depend on
 * the TypeScript compiler. The goal is to catch the dominant failure
 * mode (`Export named 'X' not found in module '@shrkcrft/plugin-api'`)
 * before publish, not to be a full module-graph analyser.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';

export const PACK_SYMBOL_COMPAT_SCHEMA = 'sharkcraft.pack-symbol-compat/v1';

export interface IPluginApiImport {
  /** Absolute path to the pack contribution file. */
  file: string;
  /** Specifier exactly as it appears in the import statement. */
  importedSymbols: readonly string[];
}

export interface IPackSymbolCompatFinding {
  /** Symbol the pack imports. */
  symbol: string;
  /** Where the symbol is used. */
  files: readonly string[];
  status: 'available' | 'missing';
}

export type PackSymbolSourceMode = 'source' | 'declaration' | 'dist-js' | 'fallback' | 'none';
export type PackSymbolConfidence = 'high' | 'medium' | 'low';

export interface IPackSymbolCompatReport {
  schema: typeof PACK_SYMBOL_COMPAT_SCHEMA;
  packPath: string;
  consumerRoot: string | null;
  pluginApiSource: string | null;
  pluginApiResolution: 'consumer-node-modules' | 'consumer-symlink' | 'pack-node-modules' | 'not-found';
  availableSymbols: readonly string[];
  findings: readonly IPackSymbolCompatFinding[];
  /** Convenience: symbols the pack uses that are missing from the consumer. */
  missingSymbols: readonly string[];
  /** Total imports inspected. */
  imports: readonly IPluginApiImport[];
  /** True iff there are no missing symbols. */
  compatible: boolean;
  /** Suggested fixes for each missing symbol (best-effort, deterministic). */
  suggestions: readonly string[];
  /** How the symbols were discovered. */
  sourceMode: PackSymbolSourceMode;
  /** Confidence in the export list. */
  confidence: PackSymbolConfidence;
  /** Files inspected when collecting available symbols. */
  filesInspected: readonly string[];
}

const NAMED_IMPORT_RE = /^\s*import\s*(?:type\s+)?\{([^}]+)\}\s*from\s*['"]@shrkcrft\/plugin-api['"]/;
const DEFAULT_IMPORT_RE = /^\s*import\s+(\w+)\s*(?:,\s*\{([^}]+)\})?\s*from\s*['"]@shrkcrft\/plugin-api['"]/;

function listContributionFiles(packPath: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const full = nodePath.join(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(full);
      else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry) && !entry.endsWith('.d.ts')) {
        out.push(full);
      }
    }
  };
  const srcDir = nodePath.join(packPath, 'src');
  walk(existsSync(srcDir) ? srcDir : packPath);
  return out;
}

function extractImports(file: string): string[] {
  let body: string;
  try {
    body = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const named = raw.match(NAMED_IMPORT_RE);
    if (named) {
      for (const symbol of named[1]!.split(',')) {
        const clean = symbol.replace(/\s+as\s+\w+/, '').trim();
        if (clean) names.push(clean);
      }
      continue;
    }
    const def = raw.match(DEFAULT_IMPORT_RE);
    if (def) {
      // Default import — track as a symbol name. Plugin-api has no default
      // export today, so this is mostly diagnostic.
      names.push(def[1]!);
      if (def[2]) {
        for (const symbol of def[2].split(',')) {
          const clean = symbol.replace(/\s+as\s+\w+/, '').trim();
          if (clean) names.push(clean);
        }
      }
    }
  }
  return names;
}

interface IResolvedPluginApi {
  source: string;
  resolution: IPackSymbolCompatReport['pluginApiResolution'];
  sourceMode: PackSymbolSourceMode;
}

function inferSourceMode(rel: string): PackSymbolSourceMode {
  if (rel.startsWith('src/')) return 'source';
  if (rel.endsWith('.d.ts')) return 'declaration';
  if (rel.endsWith('.js') || rel.endsWith('.cjs') || rel.endsWith('.mjs')) return 'dist-js';
  return 'fallback';
}

function resolvePluginApi(consumerRoot: string | null, packPath: string): IResolvedPluginApi {
  const candidates: { dir: string; resolution: IResolvedPluginApi['resolution'] }[] = [];
  if (consumerRoot) {
    candidates.push({
      dir: nodePath.join(consumerRoot, 'node_modules', '@shrkcrft', 'plugin-api'),
      resolution: 'consumer-node-modules',
    });
  }
  candidates.push({
    dir: nodePath.join(packPath, 'node_modules', '@shrkcrft', 'plugin-api'),
    resolution: 'pack-node-modules',
  });
  for (const c of candidates) {
    if (!existsSync(c.dir)) continue;
    // Prefer the source `src/index.ts` (symlinked monorepo); fall back to
    // `dist/index.js` / `dist/index.d.ts`.
    const choices = [
      'src/index.ts',
      'dist/index.d.ts',
      'dist/index.js',
      'dist/index.mjs',
      'dist/index.cjs',
      'index.d.ts',
      'index.js',
      'index.cjs',
    ];
    for (const rel of choices) {
      const full = nodePath.join(c.dir, rel);
      if (existsSync(full)) {
        const resolution: IResolvedPluginApi['resolution'] =
          rel.startsWith('src/') && c.resolution === 'consumer-node-modules'
            ? 'consumer-symlink'
            : c.resolution;
        return { source: full, resolution, sourceMode: inferSourceMode(rel) };
      }
    }
  }
  return { source: '', resolution: 'not-found', sourceMode: 'none' };
}

/**
 * Collect CJS/UMD-style exports from a built JavaScript bundle.
 * Handles the patterns that bun, tsc, esbuild and rollup emit:
 *   - `Object.defineProperty(exports, "X", { ... })`
 *   - `exports.X = ...`
 *   - `module.exports.X = ...`
 *   - `module.exports = { X, Y }`
 *   - ESM bundles: `export const X`, `export { X }`, `export function X`
 */
const CJS_DEFINE_PROP_RE = /Object\.defineProperty\(\s*exports\s*,\s*['"]([A-Za-z_$][\w$]*)['"]/g;
const CJS_EXPORTS_ASSIGN_RE = /\bexports\s*\.\s*([A-Za-z_$][\w$]*)\s*=/g;
const CJS_MODULE_EXPORTS_PROP_RE = /\bmodule\s*\.\s*exports\s*\.\s*([A-Za-z_$][\w$]*)\s*=/g;
const CJS_MODULE_EXPORTS_OBJECT_RE = /\bmodule\s*\.\s*exports\s*=\s*\{([^}]+)\}/;

function collectJsExports(file: string): Set<string> {
  const out = new Set<string>();
  let body: string;
  try {
    body = readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const m of body.matchAll(CJS_DEFINE_PROP_RE)) {
    if (m[1] && m[1] !== '__esModule') out.add(m[1]);
  }
  for (const m of body.matchAll(CJS_EXPORTS_ASSIGN_RE)) {
    if (m[1] && m[1] !== '__esModule') out.add(m[1]);
  }
  for (const m of body.matchAll(CJS_MODULE_EXPORTS_PROP_RE)) {
    if (m[1] && m[1] !== '__esModule') out.add(m[1]);
  }
  const objMatch = body.match(CJS_MODULE_EXPORTS_OBJECT_RE);
  if (objMatch && objMatch[1]) {
    for (const piece of objMatch[1].split(',')) {
      const name = piece.split(':')[0]?.trim();
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) out.add(name);
    }
  }
  // Also pick up ESM-style `export const`/`export function`/`export { X }`
  for (const raw of body.split(/\r?\n/)) {
    const named = raw.match(EXPORT_NAMED_RE);
    if (named && named[1]) out.add(named[1]);
    const block = raw.match(EXPORT_BLOCK_RE);
    if (block && !/from\s+['"]/.test(raw)) {
      for (const symbol of block[1]!.split(',')) {
        const clean = symbol.replace(/\s+as\s+(\w+)/, '$1').trim();
        if (clean && /^[A-Za-z_$][\w$]*$/.test(clean)) out.add(clean);
      }
    }
  }
  return out;
}

const EXPORT_NAMED_RE =
  /^\s*export\s+(?:async\s+)?(?:declare\s+)?(?:function|class|interface|enum|type|const|let|var)\s+(\w+)/;
const EXPORT_BLOCK_RE = /^\s*export\s*\{([^}]+)\}/;
const RE_EXPORT_RE = /^\s*export\s*\*\s+from\s*['"]([^'"]+)['"]/;
const RE_EXPORT_NAMED_RE = /^\s*export\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/;

function collectExports(file: string, visited: Set<string>): Set<string> {
  if (visited.has(file)) return new Set();
  visited.add(file);
  const out = new Set<string>();
  let body: string;
  try {
    body = readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const raw of body.split(/\r?\n/)) {
    const named = raw.match(EXPORT_NAMED_RE);
    if (named) {
      out.add(named[1]!);
      continue;
    }
    const block = raw.match(EXPORT_BLOCK_RE);
    if (block && !/from\s+['"]/.test(raw)) {
      for (const symbol of block[1]!.split(',')) {
        const clean = symbol.replace(/\s+as\s+(\w+)/, '$1').trim();
        if (clean) out.add(clean);
      }
      continue;
    }
    const reExport = raw.match(RE_EXPORT_RE);
    if (reExport) {
      const childRel = reExport[1]!;
      const candidate = resolveRelative(file, childRel);
      if (candidate) {
        for (const symbol of collectExports(candidate, visited)) out.add(symbol);
      }
      continue;
    }
    const reExportNamed = raw.match(RE_EXPORT_NAMED_RE);
    if (reExportNamed) {
      for (const symbol of reExportNamed[1]!.split(',')) {
        const clean = symbol.replace(/\s+as\s+(\w+)/, '$1').trim();
        if (clean) out.add(clean);
      }
    }
  }
  return out;
}

function resolveRelative(fromFile: string, rel: string): string | null {
  if (!rel.startsWith('.')) return null;
  const base = nodePath.resolve(nodePath.dirname(fromFile), rel);
  const candidates = [
    base + '.ts',
    base + '.tsx',
    base + '.js',
    base + '.mjs',
    base + '.cjs',
    nodePath.join(base, 'index.ts'),
    nodePath.join(base, 'index.tsx'),
    nodePath.join(base, 'index.js'),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

export interface IPackSymbolCompatInput {
  packPath: string;
  consumerRoot?: string | null;
  /** Scan dist/*.js patterns even when TS source is present. */
  distAware?: boolean;
}

function confidenceFor(mode: PackSymbolSourceMode, count: number): PackSymbolConfidence {
  if (mode === 'source' || mode === 'declaration') return 'high';
  if (mode === 'dist-js' && count >= 3) return 'medium';
  if (mode === 'dist-js') return 'low';
  if (mode === 'none') return 'low';
  return 'low';
}

export function checkPackSymbolCompat(
  input: IPackSymbolCompatInput,
): IPackSymbolCompatReport {
  const packAbs = nodePath.resolve(input.packPath);
  const consumerRoot = input.consumerRoot ? nodePath.resolve(input.consumerRoot) : null;
  const resolved = resolvePluginApi(consumerRoot, packAbs);
  const filesInspected: string[] = [];
  let availableSet = new Set<string>();
  let usedMode: PackSymbolSourceMode = resolved.sourceMode;
  if (resolved.source.length > 0) {
    if (resolved.sourceMode === 'dist-js') {
      availableSet = collectJsExports(resolved.source);
      filesInspected.push(resolved.source);
    } else {
      availableSet = collectExports(resolved.source, new Set());
      filesInspected.push(resolved.source);
    }
  }
  // Dist-aware mode — when explicitly requested, also scan dist/*.js to
  // pick up exports a declaration file omits.
  if (input.distAware && consumerRoot) {
    const distDir = nodePath.join(
      consumerRoot,
      'node_modules',
      '@shrkcrft',
      'plugin-api',
      'dist',
    );
    if (existsSync(distDir)) {
      for (const entry of safeReaddir(distDir)) {
        if (!/\.(js|cjs|mjs)$/.test(entry)) continue;
        const full = nodePath.join(distDir, entry);
        for (const s of collectJsExports(full)) availableSet.add(s);
        filesInspected.push(full);
      }
      if (resolved.sourceMode === 'declaration') usedMode = 'dist-js';
    }
  }
  const importsByFile: IPluginApiImport[] = [];
  const symbolToFiles = new Map<string, Set<string>>();
  for (const file of listContributionFiles(packAbs)) {
    const symbols = extractImports(file);
    if (symbols.length === 0) continue;
    importsByFile.push({ file, importedSymbols: symbols });
    for (const s of symbols) {
      let list = symbolToFiles.get(s);
      if (!list) {
        list = new Set();
        symbolToFiles.set(s, list);
      }
      list.add(file);
    }
  }
  const findings: IPackSymbolCompatFinding[] = [];
  for (const [symbol, files] of symbolToFiles) {
    const status = availableSet.has(symbol) ? 'available' : 'missing';
    findings.push({ symbol, files: [...files], status });
  }
  findings.sort((a, b) => a.symbol.localeCompare(b.symbol));
  const missingSymbols = findings.filter((f) => f.status === 'missing').map((f) => f.symbol);
  const suggestions: string[] = [];
  if (missingSymbols.length === 0) {
    if (resolved.resolution === 'not-found') {
      suggestions.push(
        'No installed @shrkcrft/plugin-api was found. Pass --consumer-root to point at the consumer workspace if symbols differ across versions.',
      );
    }
  } else {
    suggestions.push(
      `Pack imports ${missingSymbols.length} symbol(s) that the consumer's @shrkcrft/plugin-api does not export.`,
    );
    suggestions.push(
      `1. Bump @shrkcrft/plugin-api in the consumer workspace to a version that exports ${missingSymbols
        .slice(0, 4)
        .map((s) => '`' + s + '`')
        .join(', ')}${missingSymbols.length > 4 ? ', …' : ''}.`,
    );
    suggestions.push(
      '2. Widen `peerDependencies."@shrkcrft/plugin-api"` only if those symbols are stable across the range.',
    );
    suggestions.push(
      '3. Replace the helper imports with plain structural object literals (`export default ([...] as const)`).',
    );
    suggestions.push(
      '4. Drop the import entirely if the helper is no longer needed by your contributions.',
    );
  }
  return {
    schema: PACK_SYMBOL_COMPAT_SCHEMA,
    packPath: packAbs,
    consumerRoot,
    pluginApiSource: resolved.source || null,
    pluginApiResolution: resolved.resolution,
    availableSymbols: [...availableSet].sort(),
    findings,
    missingSymbols,
    imports: importsByFile,
    compatible: missingSymbols.length === 0,
    suggestions,
    sourceMode: usedMode,
    confidence: confidenceFor(usedMode, availableSet.size),
    filesInspected,
  };
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
