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
import type { ISymbolMemberEntry } from './symbol-member-entry.ts';
import { SymbolMemberKind } from './symbol-member-kind.ts';

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
  /** `Owner.member` where the owner is exported from this file. */
  ExactMember = 'exact-member',
  /** `Owner.member` where the owner is declared here but not exported. */
  ExactLocalMember = 'exact-local-member',
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
  /**
   * Character span of the declaration, when it is one (a bare `export { x }`
   * has none). A reference's `contains` / `matches` reads this span, so a claim
   * about a function is checked against the function, not the whole file.
   */
  start?: number;
  end?: number;
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
  /**
   * If true, this is a NAMESPACE re-export, `export * as ns from "..."`: `name`
   * (`ns`) binds the whole target module, not a declaration inside it. `star`
   * is false — the target's names are NOT forwarded one by one.
   */
  namespace?: boolean;
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
  /**
   * Members of top-level declarations, one level deep (class / interface / enum
   * / namespace / `const x = { … }`). Additive and optional: the graph indexer
   * reads only `exports` / `locals` / `reExports`, so its node set is unchanged.
   */
  members?: readonly ISymbolMemberEntry[];
  /** True when a default export exists. */
  hasDefaultExport: boolean;
  /** Default export name where identifiable (`export default function foo()` → "foo"). */
  defaultExportName?: string;
}

/** A name that can address a member statically (computed names cannot). */
function staticMemberName(name: ts.PropertyName | undefined): string | undefined {
  if (!name) return undefined;
  if (
    ts.isIdentifier(name) ||
    ts.isPrivateIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  return undefined;
}

function hasStaticModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  return !!ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword);
}

/** Strip `as const` / `satisfies X` / parentheses around an initializer. */
function unwrapInitializer(e: ts.Expression): ts.Expression {
  let cur = e;
  while (
    ts.isAsExpression(cur) ||
    ts.isSatisfiesExpression(cur) ||
    ts.isParenthesizedExpression(cur) ||
    ts.isTypeAssertionExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}

/** Collect the one-level members of a top-level statement into `out`. */
function collectMembers(sf: ts.SourceFile, stmt: ts.Statement, out: ISymbolMemberEntry[]): void {
  const push = (
    owner: string,
    node: ts.Node,
    name: string | undefined,
    kind: SymbolMemberKind,
    isStatic = false,
  ): void => {
    if (!name) return;
    out.push({
      owner,
      name,
      kind,
      static: isStatic,
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      start: node.getStart(sf),
      end: node.getEnd(),
    });
  };
  if (ts.isClassDeclaration(stmt) && stmt.name) {
    const owner = stmt.name.text;
    for (const m of stmt.members) {
      if (ts.isMethodDeclaration(m)) {
        push(owner, m, staticMemberName(m.name), SymbolMemberKind.Method, hasStaticModifier(m));
      } else if (ts.isPropertyDeclaration(m)) {
        push(owner, m, staticMemberName(m.name), SymbolMemberKind.Property, hasStaticModifier(m));
      } else if (ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m)) {
        push(owner, m, staticMemberName(m.name), SymbolMemberKind.Accessor, hasStaticModifier(m));
      }
    }
    return;
  }
  if (ts.isInterfaceDeclaration(stmt)) {
    for (const m of stmt.members) {
      if (ts.isPropertySignature(m) || ts.isMethodSignature(m)) {
        push(stmt.name.text, m, staticMemberName(m.name), SymbolMemberKind.InterfaceMember);
      }
    }
    return;
  }
  if (ts.isEnumDeclaration(stmt)) {
    for (const m of stmt.members) {
      push(stmt.name.text, m, staticMemberName(m.name), SymbolMemberKind.EnumMember);
    }
    return;
  }
  if (
    ts.isModuleDeclaration(stmt) &&
    ts.isIdentifier(stmt.name) &&
    stmt.body !== undefined &&
    ts.isModuleBlock(stmt.body)
  ) {
    const owner = stmt.name.text;
    for (const s of stmt.body.statements) {
      if (ts.isVariableStatement(s)) {
        for (const d of s.declarationList.declarations) {
          if (ts.isIdentifier(d.name)) push(owner, d, d.name.text, SymbolMemberKind.NamespaceMember);
        }
      } else if (
        (ts.isFunctionDeclaration(s) ||
          ts.isClassDeclaration(s) ||
          ts.isInterfaceDeclaration(s) ||
          ts.isTypeAliasDeclaration(s) ||
          ts.isEnumDeclaration(s)) &&
        s.name
      ) {
        push(owner, s, s.name.text, SymbolMemberKind.NamespaceMember);
      }
    }
    return;
  }
  if (ts.isVariableStatement(stmt)) {
    for (const d of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || !d.initializer) continue;
      const init = unwrapInitializer(d.initializer);
      if (!ts.isObjectLiteralExpression(init)) continue;
      for (const p of init.properties) {
        if (
          ts.isPropertyAssignment(p) ||
          ts.isShorthandPropertyAssignment(p) ||
          ts.isMethodDeclaration(p) ||
          ts.isGetAccessorDeclaration(p) ||
          ts.isSetAccessorDeclaration(p)
        ) {
          push(d.name.text, p, staticMemberName(p.name), SymbolMemberKind.ObjectKey);
        }
      }
    }
  }
}

/** `Owner.member` → its halves (`.prototype.` is stripped); null for a bare name. */
function splitQualifiedSymbol(symbol: string): { owner: string; member: string } | null {
  const cleaned = symbol.replace(/\.prototype\./g, '.');
  const dot = cleaned.indexOf('.');
  if (dot <= 0 || dot === cleaned.length - 1) return null;
  return { owner: cleaned.slice(0, dot), member: cleaned.slice(dot + 1) };
}

function spanOf(e: ISymbolEntry): { start: number; end: number } | undefined {
  return e.start !== undefined && e.end !== undefined ? { start: e.start, end: e.end } : undefined;
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
  const membersList: ISymbolMemberEntry[] = [];

  for (const stmt of sf.statements) {
    // One level of members under each top-level owner — additive; nothing
    // below reads them, so the export/local/re-export sets are unchanged.
    collectMembers(sf, stmt, membersList);
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
      // `export * as ns from "./mod"` — one name bound to the whole module.
      // Recorded (it used to fall through silently, so `ns` was on no surface).
      if (stmt.exportClause && ts.isNamespaceExport(stmt.exportClause) && fromSpec) {
        reExportsList.push({
          name: stmt.exportClause.name.text,
          from: fromSpec,
          star: false,
          namespace: true,
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
          start: stmt.getStart(sf),
          end: stmt.getEnd(),
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
          start: d.getStart(sf),
          end: d.getEnd(),
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
        start: stmt.getStart(sf),
        end: stmt.getEnd(),
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
        start: stmt.getStart(sf),
        end: stmt.getEnd(),
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
    members: membersList,
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
): {
  resolution: SymbolResolution;
  message: string;
  entry?: ISymbolEntry;
  /** Set for an `Owner.member` resolution. */
  member?: ISymbolMemberEntry;
  /** A qualified spelling that WOULD resolve — `Foo.bar` for a bare member name. */
  suggestedSymbol?: string;
  /** The resolved declaration's character span, for content assertions. */
  span?: { start: number; end: number };
} {
  if (!symbol) {
    return { resolution: SymbolResolution.Unknown, message: 'No symbol provided.' };
  }
  const idx = buildSymbolIndex(fileAbsPath);
  const qualified = splitQualifiedSymbol(symbol);
  if (!idx.parsed) {
    // Text-scan fallback. A qualified name rarely appears literally, so look
    // for the member token.
    const token = qualified ? qualified.member : symbol;
    try {
      const text = readFileSync(fileAbsPath, 'utf8');
      if (text.includes(token)) {
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
  if (qualified) return resolveMemberInIndex(idx, qualified.owner, qualified.member, symbol);
  const exp = idx.exports.find((e) => e.name === symbol);
  if (exp) {
    const span = spanOf(exp);
    return {
      resolution: SymbolResolution.ExactExport,
      message: `Exact exported declaration of \`${symbol}\` (${exp.kind}) at line ${exp.line}.`,
      entry: exp,
      ...(span ? { span } : {}),
    };
  }
  const local = idx.locals.find((e) => e.name === symbol);
  if (local) {
    const span = spanOf(local);
    return {
      resolution: SymbolResolution.ExactLocal,
      message: `Local (non-exported) declaration of \`${symbol}\` (${local.kind}) at line ${local.line}.`,
      entry: local,
      ...(span ? { span } : {}),
    };
  }
  const re = idx.reExports.find((r) => r.name === symbol || (r.star && r.from.length > 0));
  if (re) {
    return {
      resolution: SymbolResolution.ExactReExport,
      message: `Re-exported via \`export${re.star ? ' *' : re.namespace ? ` * as ${symbol}` : ` { ${symbol} }`} from "${re.from}"\` at line ${re.line}.`,
    };
  }
  // Not a top-level name — but it may be a MEMBER. That stays Missing (a bare
  // name never silently widens to members), but with a route forward instead
  // of telling the author a true statement is false.
  const asMember = (idx.members ?? []).filter((m) => m.name === symbol);
  if (asMember.length > 0) {
    const owners = [...new Set(asMember.map((m) => m.owner))];
    if (owners.length === 1) {
      const m = asMember[0]!;
      // `object-key` → "an object key" (the article follows the word, not the enum spelling).
      const kindWords = String(m.kind).replace(/-/g, ' ');
      const article = /^[aeiou]/i.test(kindWords) ? 'an' : 'a';
      return {
        resolution: SymbolResolution.Missing,
        message: `\`${symbol}\` is ${article} ${kindWords} of \`${m.owner}\` (line ${m.line}), not a top-level declaration — pin it as \`${m.owner}.${symbol}\`.`,
        suggestedSymbol: `${m.owner}.${symbol}`,
      };
    }
    return {
      resolution: SymbolResolution.Missing,
      message: `\`${symbol}\` is not a top-level declaration; it is a member of ${owners
        .map((o) => `\`${o}\``)
        .join(', ')} — pin it as \`<Owner>.${symbol}\`.`,
    };
  }
  return {
    resolution: SymbolResolution.Missing,
    message: `Symbol \`${symbol}\` not declared or re-exported in this file.`,
  };
}

/** Resolve `owner.member` against one parsed file's index. */
function resolveMemberInIndex(
  idx: ISymbolIndex,
  owner: string,
  member: string,
  original: string,
): ReturnType<typeof resolveSymbolInFile> {
  const ownerExp = idx.exports.find((e) => e.name === owner);
  const ownerEntry = ownerExp ?? idx.locals.find((e) => e.name === owner);
  if (!ownerEntry) {
    const re = idx.reExports.find((r) => r.name === owner || r.star);
    if (re) {
      // Its members are declared in another file — never a false Ok.
      return {
        resolution: SymbolResolution.Unknown,
        message: `\`${owner}\` is re-exported here from "${re.from}", so its members live elsewhere — pin the declaring file to check \`${original}\`.`,
      };
    }
    return {
      resolution: SymbolResolution.Missing,
      message: `Owner \`${owner}\` of \`${original}\` is not declared in this file.`,
    };
  }
  if (member.includes('.')) {
    return {
      resolution: SymbolResolution.Unknown,
      message: `\`${original}\` is nested more than one level; only direct members (\`${owner}.<member>\`) are indexed.`,
    };
  }
  const members = (idx.members ?? []).filter((m) => m.owner === owner);
  const hit = members.find((m) => m.name === member);
  if (hit) {
    return {
      resolution: ownerExp ? SymbolResolution.ExactMember : SymbolResolution.ExactLocalMember,
      message: `\`${original}\` resolves to the ${hit.kind} \`${member}\` of \`${owner}\` at line ${hit.line}.`,
      entry: ownerEntry,
      member: hit,
      span: { start: hit.start, end: hit.end },
    };
  }
  if (ownerEntry.kind === SymbolDeclarationKind.Unknown && members.length === 0) {
    // `export { Foo }` of an imported name — declared in another file.
    return {
      resolution: SymbolResolution.Unknown,
      message: `\`${owner}\` is only re-exported here (\`export { ${owner} }\`) — pin its declaring file to check \`${original}\`.`,
    };
  }
  const shown = members.slice(0, 12).map((m) => m.name);
  const more = members.length > shown.length ? `, … (+${members.length - shown.length})` : '';
  return {
    resolution: SymbolResolution.Missing,
    message:
      `\`${owner}\` (${ownerEntry.kind}, line ${ownerEntry.line}) has no member \`${member}\`` +
      (shown.length > 0 ? ` — its members: ${shown.join(', ')}${more}.` : ' — it declares no indexed members.'),
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
