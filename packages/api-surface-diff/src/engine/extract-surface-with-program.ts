import { existsSync, readFileSync, readdirSync } from 'node:fs';
import * as nodePath from 'node:path';
import * as ts from 'typescript';
import {
  emptyCache,
  fingerprintContent,
  loadSignatureCache,
  saveSignatureCache,
  symbolCacheKey,
  type ISignatureCache,
  type ISignatureCacheFileEntry,
} from '../cache/signature-cache.ts';
import {
  API_SURFACE_SCHEMA,
  type ApiSymbolKind,
  type IApiSurface,
  type IPublicSymbol,
} from '../schema/api-surface.ts';

export interface IExtractWithProgramOptions {
  projectRoot: string;
  /** Restrict to these workspace packages. */
  packageFilter?: readonly string[];
  /** Path to tsconfig (default: `tsconfig.base.json` then `tsconfig.json`). */
  tsconfigPath?: string;
  /**
   * Cap on the wall-clock time the extractor will spend (ms). When
   * exceeded, the extractor returns what it has so far + a diagnostic.
   * Default 60 s.
   */
  timeBudgetMs?: number;
  /**
   * When true (default), reuse `.sharkcraft/api-surface/signatures.json`
   * entries whose file SHA1 matches the current content. Saves a few
   * hundred ms on incremental CI runs. Pass `false` to force a
   * full rebuild (the cache is overwritten on the next save).
   */
  useCache?: boolean;
}

export interface IExtractWithProgramResult {
  surface: IApiSurface;
  diagnostics: readonly string[];
  /** Number of source files visited by the type checker. */
  filesVisited: number;
  /** Wall-clock duration. */
  durationMs: number;
  /** Signature cache hit / miss / unchanged-file counts. */
  cacheStats: {
    enabled: boolean;
    hits: number;
    misses: number;
    /** Files whose every exported symbol was a cache hit. */
    filesReused: number;
  };
}

/**
 * Build a `ts.Program` for the project and harvest a public-API surface
 * with **canonical signature strings** for each exported symbol. The
 * signatures let the diff engine catch parameter-type / return-type /
 * member-type changes that the AST-only extractor misses.
 *
 * Costs:
 *   - ts.Program over a medium-sized repo: hundreds of ms to a few s.
 *   - Memory: roughly proportional to total .ts size.
 *
 * Opt-in only — the AST-only `extractApiSurface(snap)` remains the
 * default path. This extractor is what `--with-signatures` invokes.
 */
export function extractApiSurfaceWithProgram(
  options: IExtractWithProgramOptions,
): IExtractWithProgramResult {
  const start = Date.now();
  const timeBudgetMs = options.timeBudgetMs ?? 60_000;
  const diagnostics: string[] = [];

  const tsconfigPath = resolveTsconfig(options.projectRoot, options.tsconfigPath);
  if (!tsconfigPath) {
    return emptyResult(start, options.projectRoot, diagnostics, 0,
      `no tsconfig found under ${options.projectRoot} (looked for tsconfig.base.json, tsconfig.json)`);
  }

  const program = buildProgram(tsconfigPath, options.projectRoot, diagnostics);
  if (!program) {
    return emptyResult(start, options.projectRoot, diagnostics, 0,
      `failed to build ts.Program from ${tsconfigPath}`);
  }
  const checker = program.getTypeChecker();
  const fileToPackage = buildFileToPackageMap(options.projectRoot);
  const filter = options.packageFilter && options.packageFilter.length > 0
    ? new Set(options.packageFilter)
    : undefined;

  // Signature cache (file SHA1 → per-symbol signature) — load once,
  // write back at the end. Cache disabled when `options.useCache === false`.
  const cacheEnabled = options.useCache !== false;
  const oldCache: ISignatureCache = cacheEnabled ? loadSignatureCache(options.projectRoot) : emptyCache();
  const newCacheFiles: Record<string, ISignatureCacheFileEntry> = {};
  let cacheHits = 0;
  let cacheMisses = 0;
  let filesReused = 0;

  const symbols: IPublicSymbol[] = [];
  let filesVisited = 0;
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile && !sf.fileName.includes(options.projectRoot)) continue;
    if (sf.fileName.includes('/node_modules/')) continue;
    if (!sf.fileName.startsWith(options.projectRoot)) continue;
    if (Date.now() - start > timeBudgetMs) {
      diagnostics.push(
        `time budget exceeded after visiting ${filesVisited} files; surface is partial`,
      );
      break;
    }
    filesVisited += 1;
    const relPath = nodePath
      .relative(options.projectRoot, sf.fileName)
      .split(nodePath.sep)
      .join('/');
    const pkg = lookupPackage(relPath, fileToPackage);
    if (filter && (!pkg || !filter.has(pkg))) continue;

    // Compute the file SHA1 once and decide whether the cache is
    // usable for this file. We still walk the module's exports below
    // — the cache only short-circuits the per-symbol type checker
    // call (the expensive part).
    const fileSha = fingerprintContent(sf.getFullText());
    const cachedEntry = cacheEnabled ? oldCache.files[relPath] : undefined;
    const fileCacheUsable = !!cachedEntry && cachedEntry.sha1 === fileSha;
    const fileNewSignatures: Record<string, string> = {};
    let fileSymbolsCount = 0;
    let fileHits = 0;

    const moduleSymbol = checker.getSymbolAtLocation(sf);
    if (!moduleSymbol) continue;
    const exported = checker.getExportsOfModule(moduleSymbol);
    for (const sym of exported) {
      // Skip module re-exports (we want declarations).
      const decls = sym.getDeclarations() ?? [];
      if (decls.length === 0) continue;
      const decl = decls[0]!;
      const declSf = decl.getSourceFile();
      if (declSf.fileName.includes('/node_modules/')) continue;
      const declRel = nodePath
        .relative(options.projectRoot, declSf.fileName)
        .split(nodePath.sep)
        .join('/');
      const declPkg = lookupPackage(declRel, fileToPackage);
      if (filter && (!declPkg || !filter.has(declPkg))) continue;

      const name = sym.getName();
      if (name === '__export') continue; // synthetic, comes from `export * from`
      const isDefault = name === 'default';
      const kind = pickKind(decl);
      const key = symbolCacheKey(name, isDefault);
      let signature: string | undefined;
      // Cache lookup is keyed by the file the symbol is *declared* in,
      // not the file we're walking — they differ for re-exports.
      const sameFile = declRel === relPath;
      if (cacheEnabled && sameFile && fileCacheUsable && cachedEntry!.signatures[key]) {
        signature = cachedEntry!.signatures[key]!;
        cacheHits += 1;
        fileHits += 1;
      } else {
        signature = serializeSymbol(checker, sym, decl);
        if (cacheEnabled) cacheMisses += 1;
      }
      if (signature && sameFile) {
        fileNewSignatures[key] = signature;
      }
      fileSymbolsCount += 1;
      symbols.push({
        id: `symbol:${declRel}#${name}`,
        name,
        kind,
        file: declRel,
        ...(declPkg ? { package: declPkg } : {}),
        isDefault,
        ...(signature ? { signature } : {}),
      });
    }

    if (cacheEnabled) {
      newCacheFiles[relPath] = { sha1: fileSha, signatures: fileNewSignatures };
      if (fileSymbolsCount > 0 && fileHits === fileSymbolsCount) filesReused += 1;
    }
  }
  // De-dupe by `id` — re-exports can surface the same declaration
  // multiple times.
  const seen = new Set<string>();
  const deduped: IPublicSymbol[] = [];
  for (const s of symbols) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    deduped.push(s);
  }
  deduped.sort((a, b) => a.id.localeCompare(b.id));
  const counts: Record<string, number> = {};
  for (const s of deduped) {
    const key = s.package ?? '<no-package>';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  // Surface filter entries that matched no known package so callers can fail
  // loudly instead of returning a silent 0-symbol surface.
  const knownPackages = new Set(fileToPackage.values());
  const unmatchedFilters =
    options.packageFilter?.filter((p) => !knownPackages.has(p)) ?? [];
  const surface: IApiSurface = {
    schema: API_SURFACE_SCHEMA,
    projectRoot: options.projectRoot,
    ...(options.packageFilter && options.packageFilter.length > 0 ? { packageFilter: options.packageFilter } : {}),
    ...(unmatchedFilters.length > 0 ? { unmatchedFilters } : {}),
    symbols: deduped,
    countsByPackage: counts,
    total: deduped.length,
  };
  if (cacheEnabled) {
    saveSignatureCache(options.projectRoot, {
      schema: oldCache.schema,
      generatedAt: oldCache.generatedAt, // overwritten by saveSignatureCache
      files: newCacheFiles,
    });
  }
  return {
    surface,
    diagnostics,
    filesVisited,
    durationMs: Date.now() - start,
    cacheStats: {
      enabled: cacheEnabled,
      hits: cacheHits,
      misses: cacheMisses,
      filesReused,
    },
  };
}

function resolveTsconfig(projectRoot: string, explicit?: string): string | undefined {
  if (explicit) {
    const abs = nodePath.isAbsolute(explicit) ? explicit : nodePath.resolve(projectRoot, explicit);
    return existsSync(abs) ? abs : undefined;
  }
  for (const name of ['tsconfig.base.json', 'tsconfig.json']) {
    const cand = nodePath.join(projectRoot, name);
    if (existsSync(cand)) return cand;
  }
  return undefined;
}

function buildProgram(
  tsconfigPath: string,
  projectRoot: string,
  diagnostics: string[],
): ts.Program | undefined {
  const raw = ts.readConfigFile(tsconfigPath, (p) => readFileSync(p, 'utf8'));
  if (raw.error) {
    diagnostics.push(`tsconfig read error: ${ts.flattenDiagnosticMessageText(raw.error.messageText, '\n')}`);
    return undefined;
  }
  const parsed = ts.parseJsonConfigFileContent(
    raw.config,
    ts.sys,
    nodePath.dirname(tsconfigPath),
  );
  for (const d of parsed.errors) {
    diagnostics.push(`tsconfig parse: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`);
  }
  // Add the workspace's own source roots in case tsconfig.base.json
  // doesn't list them (the SharkCraft monorepo's tsconfig.base.json
  // uses `include: ['packages/*/src/**/*.ts']` already).
  return ts.createProgram({
    rootNames: parsed.fileNames,
    options: {
      ...parsed.options,
      // Forcibly disable emit / type errors that don't matter for symbol
      // discovery.
      noEmit: true,
      skipLibCheck: true,
    },
  });
}

function pickKind(decl: ts.Declaration): ApiSymbolKind {
  if (ts.isClassDeclaration(decl)) return 'class';
  if (ts.isFunctionDeclaration(decl)) return 'function';
  if (ts.isInterfaceDeclaration(decl)) return 'interface';
  if (ts.isTypeAliasDeclaration(decl)) return 'type-alias';
  if (ts.isEnumDeclaration(decl)) return 'enum';
  if (ts.isVariableDeclaration(decl)) {
    const list = decl.parent as ts.VariableDeclarationList | undefined;
    if (list && list.flags & ts.NodeFlags.Const) return 'const';
    if (list && list.flags & ts.NodeFlags.Let) return 'let';
    return 'var';
  }
  if (ts.isModuleDeclaration(decl)) {
    if (decl.flags & ts.NodeFlags.Namespace) return 'namespace';
    return 'module';
  }
  return 'unknown';
}

const TYPE_FORMAT_FLAGS =
  ts.TypeFormatFlags.NoTruncation |
  ts.TypeFormatFlags.WriteArrayAsGenericType |
  ts.TypeFormatFlags.UseStructuralFallback |
  ts.TypeFormatFlags.InTypeAlias;

function serializeSymbol(checker: ts.TypeChecker, sym: ts.Symbol, decl: ts.Declaration): string | undefined {
  try {
    const allDecls = sym.getDeclarations() ?? [decl];
    const typeParamNames = extractTypeParameterNames(allDecls);
    // Type-shape symbols (interface / type alias / class) need
    // structural serialization — `typeToString` would just print the
    // symbol's own name (`IUser`) and miss member changes. Walk the
    // properties explicitly so two interfaces with different member
    // lists serialize to different strings.
    if (sym.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.Class)) {
      return normalizeGenerics(serializeStructuralType(checker, sym, decl), typeParamNames);
    }
    if (sym.flags & ts.SymbolFlags.Enum) {
      return serializeEnum(checker, sym);
    }
    if (sym.flags & ts.SymbolFlags.TypeAlias) {
      const type = checker.getDeclaredTypeOfSymbol(sym);
      // For type aliases, typeToString *does* expand most shapes — but
      // when the alias resolves to another named type the result is
      // just the name. Fall back to structural for object types.
      if (type.flags & ts.TypeFlags.Object) {
        return normalizeGenerics(canonicalizeSignature(formatObjectType(checker, type, decl)), typeParamNames);
      }
      return normalizeGenerics(
        canonicalizeSignature(checker.typeToString(type, decl, TYPE_FORMAT_FLAGS)),
        typeParamNames,
      );
    }
    // Value symbols (function / const / let / var): serialize the
    // expression / call-signature type.
    const type = checker.getTypeOfSymbolAtLocation(sym, decl);
    const text = checker.typeToString(type, decl, TYPE_FORMAT_FLAGS);
    return normalizeGenerics(canonicalizeSignature(text), typeParamNames);
  } catch {
    return undefined;
  }
}

/**
 * Collect type-parameter names from a symbol's declarations, in
 * declaration order. Used to substitute `T`/`U`/etc. with positional
 * placeholders so rename-only refactors don't read as breaking changes
 * in the diff.
 *
 * Only top-level type parameters on the declaration itself are
 * captured; nested generic closures keep their original names (we
 * don't have a stable positional identity for them at the symbol
 * level).
 */
function extractTypeParameterNames(decls: readonly ts.Declaration[]): readonly string[] {
  for (const decl of decls) {
    const tp = (decl as unknown as { typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration> }).typeParameters;
    if (tp && tp.length > 0) {
      const names: string[] = [];
      for (const t of tp) {
        if (ts.isIdentifier(t.name)) names.push(t.name.text);
      }
      if (names.length > 0) return names;
    }
  }
  return [];
}

function normalizeGenerics(serialized: string, paramNames: readonly string[]): string {
  if (paramNames.length === 0) return serialized;
  // Substitute in two passes so a rename like `T → U` doesn't collide
  // when an output placeholder happens to match another input name.
  // First pass: rename each input to a unique placeholder using a
  // marker prefix that can't appear in legitimate identifiers.
  let out = serialized;
  for (let i = 0; i < paramNames.length; i += 1) {
    const re = new RegExp('\\b' + escapeRegExp(paramNames[i]!) + '\\b', 'g');
    out = out.replace(re, `P${i}`);
  }
  // Second pass: turn the markers into stable, human-readable
  // placeholders.
  out = out.replace(/P(\d+)/g, '__P$1');
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function serializeStructuralType(
  checker: ts.TypeChecker,
  sym: ts.Symbol,
  decl: ts.Declaration,
): string {
  const type = checker.getDeclaredTypeOfSymbol(sym);
  return canonicalizeSignature(formatObjectType(checker, type, decl));
}

function formatObjectType(checker: ts.TypeChecker, type: ts.Type, locus: ts.Node): string {
  const props = checker.getPropertiesOfType(type);
  const memberStrs: string[] = [];
  for (const prop of props) {
    const propDecl = prop.getDeclarations()?.[0] ?? locus;
    const propType = checker.getTypeOfSymbolAtLocation(prop, propDecl);
    const optional = (prop.flags & ts.SymbolFlags.Optional) !== 0 ? '?' : '';
    memberStrs.push(`${prop.getName()}${optional}: ${checker.typeToString(propType, propDecl, TYPE_FORMAT_FLAGS)}`);
  }
  // Call signatures (function-shaped object types).
  for (const sig of checker.getSignaturesOfType(type, ts.SignatureKind.Call)) {
    memberStrs.push(`(call): ${checker.signatureToString(sig, locus)}`);
  }
  // Construct signatures (classes / interfaces with new(...)).
  for (const sig of checker.getSignaturesOfType(type, ts.SignatureKind.Construct)) {
    memberStrs.push(`(new): ${checker.signatureToString(sig, locus)}`);
  }
  memberStrs.sort();
  return `{ ${memberStrs.join('; ')} }`;
}

function serializeEnum(checker: ts.TypeChecker, sym: ts.Symbol): string {
  const decls = sym.getDeclarations() ?? [];
  const members: string[] = [];
  for (const decl of decls) {
    if (!ts.isEnumDeclaration(decl)) continue;
    for (const member of decl.members) {
      if (ts.isIdentifier(member.name)) {
        members.push(member.name.text);
      } else if (ts.isStringLiteral(member.name)) {
        members.push(`'${member.name.text}'`);
      }
    }
  }
  members.sort();
  return canonicalizeSignature(`enum { ${members.join(', ')} }`);
  // (Silence unused-import warning if checker isn't referenced.)
  void checker;
}

/**
 * Normalize whitespace so two semantically-equivalent signatures
 * compare equal across tsserver / compiler version drift.
 */
function canonicalizeSignature(s: string): string {
  return s.replace(/\s+/g, ' ').replace(/\s*([,;:<>(){}|&=])\s*/g, '$1').trim();
}

function buildFileToPackageMap(projectRoot: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const pkgJson = nodePath.join(projectRoot, 'package.json');
    const root = existsSync(pkgJson) ? (JSON.parse(readFileSync(pkgJson, 'utf8')) as { workspaces?: unknown }) : {};
    const patterns = normalizeWorkspaces(root.workspaces);
    for (const pattern of patterns) {
      const dir = pattern.replace(/\/\*?$/, '');
      const full = nodePath.join(projectRoot, dir);
      if (!existsSync(full)) continue;
      let children: string[];
      try {
        children = readdirSync(full);
      } catch {
        continue;
      }
      for (const child of children) {
        const inner = nodePath.join(full, child);
        const childPkg = nodePath.join(inner, 'package.json');
        if (!existsSync(childPkg)) continue;
        try {
          const pj = JSON.parse(readFileSync(childPkg, 'utf8')) as { name?: string };
          if (pj.name) {
            const rel = nodePath.relative(projectRoot, inner).split(nodePath.sep).join('/');
            out.set(rel, pj.name);
          }
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}

function lookupPackage(relPath: string, fileToPackage: ReadonlyMap<string, string>): string | undefined {
  // Walk path prefixes; pick the longest match.
  const parts = relPath.split('/');
  for (let i = parts.length - 1; i > 0; i -= 1) {
    const prefix = parts.slice(0, i).join('/');
    const hit = fileToPackage.get(prefix);
    if (hit) return hit;
  }
  return undefined;
}

function normalizeWorkspaces(value: unknown): readonly string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'object') {
    const packages = (value as { packages?: unknown }).packages;
    if (Array.isArray(packages)) return packages.filter((v): v is string => typeof v === 'string');
  }
  return [];
}

function emptyResult(
  start: number,
  projectRoot: string,
  diagnostics: string[],
  filesVisited: number,
  message: string,
): IExtractWithProgramResult {
  diagnostics.push(message);
  return {
    surface: {
      schema: API_SURFACE_SCHEMA,
      projectRoot,
      symbols: [],
      countsByPackage: {},
      total: 0,
    },
    diagnostics,
    filesVisited,
    durationMs: Date.now() - start,
    cacheStats: { enabled: false, hits: 0, misses: 0, filesReused: 0 },
  };
}
