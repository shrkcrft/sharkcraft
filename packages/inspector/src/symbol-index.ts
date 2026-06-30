/**
 * Lightweight AST-backed symbol index.
 *
 * Uses the TypeScript compiler API (single-file `createSourceFile`, no
 * full program type-checking) to identify exported / local declarations
 * and re-exports in a TS / TSX / JS / JSX file. Falls back to a text
 * scan when the file cannot be parsed.
 *
 * The index is intentionally per-file (no whole-program graph). Callers
 * that need cross-file resolution stitch results together themselves.
 *
 * Schema: sharkcraft.symbol-index/v1
 */
import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import * as ts from 'typescript';

export const SYMBOL_INDEX_SCHEMA = 'sharkcraft.symbol-index/v1';

export enum SymbolDeclarationKind {
  Class = 'class',
  Function = 'function',
  Interface = 'interface',
  TypeAlias = 'type-alias',
  Enum = 'enum',
  Const = 'const',
  Let = 'let',
  Var = 'var',
  Module = 'module',
  Namespace = 'namespace',
  Unknown = 'unknown',
}

export enum SymbolVisibility {
  Export = 'export',
  Local = 'local',
  ReExport = 're-export',
  Default = 'default',
}

export enum SymbolResolution {
  ExactExport = 'exact-export',
  ExactLocal = 'exact-local',
  ExactReExport = 'exact-reexport',
  ProbableText = 'probable-text',
  Missing = 'missing',
  Unknown = 'unknown',
}

export interface ISymbolEntry {
  name: string;
  kind: SymbolDeclarationKind;
  visibility: SymbolVisibility;
  /** Line (1-based) where the declaration starts. */
  line: number;
}

export interface IReExportEntry {
  /** Symbol name as exposed (the "name" half of `export { foo } from`). */
  name: string;
  /**
   * Original name in the target module for a RENAMED re-export
   * (`export { Orig as Exposed } from './x'` → `localName` is `Orig`). Absent
   * for a plain `export { foo } from './x'` where the exposed name equals the
   * original. `default` for `export { default as Foo } from './x'`. Threaded
   * through so the graph re-export resolver can recurse with the ORIGINAL
   * name and land on the real declaring symbol instead of giving up.
   */
  localName?: string;
  /** Original specifier path (e.g. `./feature`). */
  from: string;
  /** If true, this is `export * from "..."`. */
  star: boolean;
  line: number;
}

export interface ISymbolIndex {
  schema: typeof SYMBOL_INDEX_SCHEMA;
  file: string;
  parsed: boolean;
  parseError?: string;
  exports: readonly ISymbolEntry[];
  locals: readonly ISymbolEntry[];
  reExports: readonly IReExportEntry[];
  /** True when a default export exists. */
  hasDefaultExport: boolean;
  /** Default export name where identifiable (`export default function foo()` → "foo"). */
  defaultExportName?: string;
}

interface IBuildIndexOptions {
  /** Treat file content as if it had this path (used for tests). */
  virtualPath?: string;
}

function pickKindFromNode(node: ts.Node): SymbolDeclarationKind {
  if (ts.isClassDeclaration(node)) return SymbolDeclarationKind.Class;
  if (ts.isFunctionDeclaration(node)) return SymbolDeclarationKind.Function;
  if (ts.isInterfaceDeclaration(node)) return SymbolDeclarationKind.Interface;
  if (ts.isTypeAliasDeclaration(node)) return SymbolDeclarationKind.TypeAlias;
  if (ts.isEnumDeclaration(node)) return SymbolDeclarationKind.Enum;
  if (ts.isVariableStatement(node)) {
    const flags = node.declarationList.flags;
    if (flags & ts.NodeFlags.Const) return SymbolDeclarationKind.Const;
    if (flags & ts.NodeFlags.Let) return SymbolDeclarationKind.Let;
    return SymbolDeclarationKind.Var;
  }
  if (ts.isModuleDeclaration(node)) {
    if (node.flags & ts.NodeFlags.Namespace) return SymbolDeclarationKind.Namespace;
    return SymbolDeclarationKind.Module;
  }
  return SymbolDeclarationKind.Unknown;
}

function isExported(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const mods = ts.getModifiers(node);
  return !!mods && mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function isDefault(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const mods = ts.getModifiers(node);
  return !!mods && mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

export function buildSymbolIndex(
  fileAbsPath: string,
  content?: string,
  options: IBuildIndexOptions = {},
): ISymbolIndex {
  const filePath = options.virtualPath ?? fileAbsPath;
  let text: string;
  if (content !== undefined) {
    text = content;
  } else {
    if (!existsSync(fileAbsPath)) {
      return {
        schema: SYMBOL_INDEX_SCHEMA,
        file: filePath,
        parsed: false,
        parseError: 'file not found',
        exports: [],
        locals: [],
        reExports: [],
        hasDefaultExport: false,
      };
    }
    try {
      text = readFileSync(fileAbsPath, 'utf8');
    } catch (e) {
      return {
        schema: SYMBOL_INDEX_SCHEMA,
        file: filePath,
        parsed: false,
        parseError: (e as Error).message,
        exports: [],
        locals: [],
        reExports: [],
        hasDefaultExport: false,
      };
    }
  }

  const ext = nodePath.extname(filePath).toLowerCase();
  const scriptKind = pickScriptKind(ext);
  let sf: ts.SourceFile;
  try {
    sf = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, scriptKind);
  } catch (e) {
    return {
      schema: SYMBOL_INDEX_SCHEMA,
      file: filePath,
      parsed: false,
      parseError: (e as Error).message,
      exports: [],
      locals: [],
      reExports: [],
      hasDefaultExport: false,
    };
  }

  const exportsList: ISymbolEntry[] = [];
  const localsList: ISymbolEntry[] = [];
  const reExportsList: IReExportEntry[] = [];
  let hasDefaultExport = false;
  let defaultExportName: string | undefined;

  for (const stmt of sf.statements) {
    // export { foo, bar } from "./mod"  /  export * from "./mod"
    if (ts.isExportDeclaration(stmt)) {
      const fromSpec = stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)
        ? stmt.moduleSpecifier.text
        : '';
      const star = !stmt.exportClause;
      if (star && fromSpec) {
        reExportsList.push({
          name: '*',
          from: fromSpec,
          star: true,
          line: lineOf(sf, stmt),
        });
        continue;
      }
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const spec of stmt.exportClause.elements) {
          const name = spec.name.text;
          if (fromSpec) {
            // `export { Orig as Exposed } from './x'` — keep the ORIGINAL name
            // (`spec.propertyName`) so a renamed re-export can be resolved to
            // its real declaration. Plain `export { foo } from` has no
            // propertyName (exposed === original).
            const localName = spec.propertyName?.text;
            reExportsList.push({
              name,
              ...(localName !== undefined ? { localName } : {}),
              from: fromSpec,
              star: false,
              line: lineOf(sf, spec),
            });
          } else {
            // `export { foo }` — local re-export of a name imported above.
            exportsList.push({
              name,
              kind: SymbolDeclarationKind.Unknown,
              visibility: SymbolVisibility.Export,
              line: lineOf(sf, spec),
            });
          }
        }
        continue;
      }
    }
    // export default …
    if (ts.isExportAssignment(stmt)) {
      hasDefaultExport = true;
      if (ts.isIdentifier(stmt.expression)) {
        defaultExportName = stmt.expression.text;
      }
      continue;
    }
    // export default function/class …
    if (
      (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) &&
      isDefault(stmt)
    ) {
      hasDefaultExport = true;
      const name = stmt.name?.text;
      if (name) defaultExportName = name;
      // Also surface the name (if any) in exportsList for findability.
      if (name) {
        exportsList.push({
          name,
          kind: pickKindFromNode(stmt),
          visibility: SymbolVisibility.Default,
          line: lineOf(sf, stmt),
        });
      }
      continue;
    }

    const exported = isExported(stmt);
    // export const / let / var …
    if (ts.isVariableStatement(stmt)) {
      const kind = pickKindFromNode(stmt);
      for (const d of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        const entry: ISymbolEntry = {
          name: d.name.text,
          kind,
          visibility: exported ? SymbolVisibility.Export : SymbolVisibility.Local,
          line: lineOf(sf, d),
        };
        (exported ? exportsList : localsList).push(entry);
      }
      continue;
    }
    if (
      ts.isClassDeclaration(stmt) ||
      ts.isFunctionDeclaration(stmt) ||
      ts.isInterfaceDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt) ||
      ts.isEnumDeclaration(stmt)
    ) {
      const name = stmt.name?.text;
      if (!name) continue;
      const entry: ISymbolEntry = {
        name,
        kind: pickKindFromNode(stmt),
        visibility: exported ? SymbolVisibility.Export : SymbolVisibility.Local,
        line: lineOf(sf, stmt),
      };
      (exported ? exportsList : localsList).push(entry);
      continue;
    }
    if (ts.isModuleDeclaration(stmt) && stmt.name && ts.isIdentifier(stmt.name)) {
      const entry: ISymbolEntry = {
        name: stmt.name.text,
        kind: pickKindFromNode(stmt),
        visibility: exported ? SymbolVisibility.Export : SymbolVisibility.Local,
        line: lineOf(sf, stmt),
      };
      (exported ? exportsList : localsList).push(entry);
    }
  }

  return {
    schema: SYMBOL_INDEX_SCHEMA,
    file: filePath,
    parsed: true,
    exports: exportsList,
    locals: localsList,
    reExports: reExportsList,
    hasDefaultExport,
    ...(defaultExportName ? { defaultExportName } : {}),
  };
}

function pickScriptKind(ext: string): ts.ScriptKind {
  switch (ext) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

/**
 * Resolve a symbol within a single file using the AST index. Returns the
 * resolution kind + a small explanation. No cross-file traversal.
 */
export function resolveSymbolInFile(
  fileAbsPath: string,
  symbol: string,
): { resolution: SymbolResolution; message: string; entry?: ISymbolEntry } {
  if (!symbol) {
    return { resolution: SymbolResolution.Unknown, message: 'No symbol provided.' };
  }
  const idx = buildSymbolIndex(fileAbsPath);
  if (!idx.parsed) {
    // Text-scan fallback.
    try {
      const text = readFileSync(fileAbsPath, 'utf8');
      if (text.includes(symbol)) {
        return {
          resolution: SymbolResolution.ProbableText,
          message: `\`${symbol}\` appears in the file text but the AST could not be parsed.`,
        };
      }
      return { resolution: SymbolResolution.Missing, message: `\`${symbol}\` not found.` };
    } catch {
      return { resolution: SymbolResolution.Unknown, message: 'Could not read file.' };
    }
  }
  const exp = idx.exports.find((e) => e.name === symbol);
  if (exp) {
    return {
      resolution: SymbolResolution.ExactExport,
      message: `Exact exported declaration of \`${symbol}\` (${exp.kind}) at line ${exp.line}.`,
      entry: exp,
    };
  }
  const local = idx.locals.find((e) => e.name === symbol);
  if (local) {
    return {
      resolution: SymbolResolution.ExactLocal,
      message: `Local (non-exported) declaration of \`${symbol}\` (${local.kind}) at line ${local.line}.`,
      entry: local,
    };
  }
  const re = idx.reExports.find((r) => r.name === symbol || (r.star && r.from.length > 0));
  if (re) {
    return {
      resolution: SymbolResolution.ExactReExport,
      message: `Re-exported via \`export${re.star ? ' *' : ` { ${symbol} }`} from "${re.from}"\` at line ${re.line}.`,
    };
  }
  return {
    resolution: SymbolResolution.Missing,
    message: `Symbol \`${symbol}\` not declared or re-exported in this file.`,
  };
}

// ── Project-wide symbol resolution ──────────────────────────────────────

import { readdirSync, statSync } from 'node:fs';

export interface ISymbolMatch {
  /** Absolute file path. */
  file: string;
  /** Relative to projectRoot. */
  relativePath: string;
  resolution: SymbolResolution;
  /** Resolution detail message. */
  message: string;
  /** Declaration kind / visibility if known. */
  kind?: SymbolDeclarationKind;
  visibility?: SymbolVisibility;
  /** Line number (1-based) for export/local matches. */
  line?: number;
}

export interface ISymbolImpactResult {
  schema: 'sharkcraft.symbol-impact/v1';
  symbol: string;
  language: string;
  /** Files containing exact-export / exact-local matches. */
  exactMatches: readonly ISymbolMatch[];
  /** Files containing probable-text (no AST parse / text scan). */
  textMatches: readonly ISymbolMatch[];
  /** When at most one exact-export match exists, the impact engine should
   *  treat that file as the canonical target. */
  primaryFile?: string;
  /** Free-form diagnostics. */
  diagnostics: readonly string[];
}

const DEFAULT_SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '.sharkcraft',
  'coverage',
  'target',
  'out',
]);

const TS_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

function walk(dir: string, accept: (file: string) => boolean, out: string[]): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (DEFAULT_SKIP_DIRS.has(name)) continue;
    const full = nodePath.join(dir, name);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) walk(full, accept, out);
    else if (stat.isFile() && accept(full)) out.push(full);
  }
}

export interface IFindSymbolOptions {
  /** Language hint — currently typescript|auto. */
  language?: 'typescript' | 'java' | 'csharp' | 'python' | 'go' | 'rust' | 'auto';
  /** Cap scanned files. Default 4000. */
  maxFiles?: number;
}

export function findSymbolInProject(
  projectRoot: string,
  symbol: string,
  options: IFindSymbolOptions = {},
): ISymbolImpactResult {
  const language = options.language ?? 'auto';
  const accept = (file: string): boolean => {
    const ext = nodePath.extname(file).toLowerCase();
    if (language === 'auto' || language === 'typescript') return TS_EXTS.has(ext);
    if (language === 'java') return ext === '.java';
    if (language === 'csharp') return ext === '.cs';
    if (language === 'python') return ext === '.py';
    if (language === 'go') return ext === '.go';
    if (language === 'rust') return ext === '.rs';
    return false;
  };
  const files: string[] = [];
  walk(projectRoot, accept, files);
  const limited = files.slice(0, options.maxFiles ?? 4000);
  const exactMatches: ISymbolMatch[] = [];
  const textMatches: ISymbolMatch[] = [];
  const diagnostics: string[] = [];
  for (const f of limited) {
    let text: string;
    try {
      text = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    if (!text.includes(symbol)) continue;
    const rel = nodePath.relative(projectRoot, f);
    if (TS_EXTS.has(nodePath.extname(f).toLowerCase())) {
      const idx = buildSymbolIndex(f);
      if (!idx.parsed) {
        textMatches.push({
          file: f,
          relativePath: rel,
          resolution: SymbolResolution.ProbableText,
          message: idx.parseError ?? 'parse error',
        });
        continue;
      }
      const exp = idx.exports.find((e) => e.name === symbol);
      if (exp) {
        exactMatches.push({
          file: f,
          relativePath: rel,
          resolution: SymbolResolution.ExactExport,
          message: `exported ${exp.kind} at line ${exp.line}`,
          kind: exp.kind,
          visibility: exp.visibility,
          line: exp.line,
        });
        continue;
      }
      const local = idx.locals.find((e) => e.name === symbol);
      if (local) {
        exactMatches.push({
          file: f,
          relativePath: rel,
          resolution: SymbolResolution.ExactLocal,
          message: `local ${local.kind} at line ${local.line} — not exported`,
          kind: local.kind,
          visibility: local.visibility,
          line: local.line,
        });
        continue;
      }
      textMatches.push({
        file: f,
        relativePath: rel,
        resolution: SymbolResolution.ProbableText,
        message: 'token appears in file text',
      });
    } else {
      // Non-TS: text-only.
      textMatches.push({
        file: f,
        relativePath: rel,
        resolution: SymbolResolution.ProbableText,
        message: 'token appears in file text (no AST scanner for this language)',
      });
    }
  }
  if (files.length > limited.length) {
    diagnostics.push(
      `scanned the first ${limited.length} files (${files.length - limited.length} skipped — bump --max-files to increase)`,
    );
  }
  // Primary file: only if exactly one exported declaration.
  const exportedMatches = exactMatches.filter((m) => m.resolution === SymbolResolution.ExactExport);
  let primaryFile: string | undefined;
  if (exportedMatches.length === 1) {
    primaryFile = exportedMatches[0]!.relativePath;
  } else if (exportedMatches.length === 0 && exactMatches.length === 1) {
    primaryFile = exactMatches[0]!.relativePath;
  }
  return {
    schema: 'sharkcraft.symbol-impact/v1',
    symbol,
    language,
    exactMatches,
    textMatches,
    ...(primaryFile ? { primaryFile } : {}),
    diagnostics,
  };
}
