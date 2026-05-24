import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import * as ts from 'typescript';
import {
  buildSymbolIndex,
  type ISymbolIndex,
  SymbolVisibility,
} from '@shrkcrft/inspector';
import type { IEdge } from '../schema/edge.ts';
import { EdgeKind } from '../schema/edge-kind.ts';
import type { IFileFingerprint } from '../schema/file-fingerprint.ts';
import type { INode } from '../schema/node.ts';
import { NodeKind } from '../schema/node-kind.ts';

export const EXTRACT_TS_FILE_SOURCE = 'extract-ts-file@v1';

/**
 * Per-file import scan. The boundaries package owns the project-wide
 * `scanImports`; for the graph extractor we need a per-file pass that
 * runs against a buffer we already have in hand. The regexes mirror
 * `boundaries/scan-imports.ts` deliberately — keeping them in sync is a
 * test obligation, not a runtime one.
 */
const IMPORT_RE = /(?:^|\s)(?:import|export)\s+[^'"`]*?from\s+['"]([^'"`]+)['"]/g;
const SIDE_EFFECT_IMPORT_RE = /(?:^|\s)import\s+['"]([^'"`]+)['"]/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"`]+)['"]\s*\)/g;
const REQUIRE_RE = /\brequire\s*\(\s*['"]([^'"`]+)['"]\s*\)/g;

export interface IExtractedFile {
  fileNode: INode;
  symbolNodes: readonly INode[];
  edges: readonly IEdge[];
  /** Specifiers we observed. Resolution happens later in the indexer. */
  rawImportSpecifiers: readonly IRawImportSpecifier[];
  /**
   * Named / default import bindings: `localName` is what the file uses
   * to refer to the symbol; resolution to a target file id happens in
   * the indexer post-pass. Namespace imports (`import * as X`) are
   * intentionally skipped — the binder would need cross-file member
   * lookup which is out of scope for the MVP.
   */
  importBindings: readonly IImportBinding[];
  /**
   * Identifier references found in the file body. The indexer post-pass
   * filters these against the resolved bindings + the file's own local
   * symbols and emits `references-symbol` / `calls-symbol` edges.
   */
  identifierReferences: readonly IIdentifierReference[];
}

export interface IRawImportSpecifier {
  specifier: string;
  line: number;
  /** Best-effort kind: 'static' | 'side-effect' | 'dynamic' | 'require'. */
  kind: string;
}

export interface IImportBinding {
  /** Identifier name used inside this file. */
  localName: string;
  /** Name as exported by the target module. `default` for default imports. */
  importedName: string;
  specifier: string;
  isDefault: boolean;
  line: number;
}

export interface IIdentifierReference {
  /** Identifier text at the use site. */
  name: string;
  line: number;
  /** True when the identifier appears as the callee of a call expression. */
  isCall: boolean;
}

/**
 * Extract graph entities from a single TS/TSX/JS/JSX file.
 *
 * Re-uses `buildSymbolIndex` for symbol detection (per-file AST, no full
 * program). Import edges carry the literal specifier; resolution to the
 * target file id happens in `resolve-imports.ts` (R64).
 */
export function extractTsFile(
  fingerprint: IFileFingerprint,
  absPath: string,
  content?: string,
): IExtractedFile {
  const text = content ?? readFileSync(absPath, 'utf8');

  // Single-file-component languages (Vue, Svelte, Astro) are not pure TS.
  // We produce a minimal File node and let `@shrkcrft/framework-scanners`
  // detect component-level structure. Imports still extracted from
  // `<script>` blocks via the regex pass below.
  if (
    fingerprint.language === 'vue' ||
    fingerprint.language === 'svelte' ||
    fingerprint.language === 'astro' ||
    fingerprint.language === 'graphql'
  ) {
    const fileNode = makeFileNodeForNonTs(fingerprint);
    return {
      fileNode,
      symbolNodes: [],
      edges: [],
      rawImportSpecifiers: fingerprint.language === 'graphql' ? [] : scanFileImports(text),
      importBindings: [],
      identifierReferences: [],
    };
  }

  const idx = buildSymbolIndex(absPath, text);

  const fileNode = makeFileNode(fingerprint, idx);
  const symbolNodes: INode[] = [];
  const edges: IEdge[] = [];

  for (const e of idx.exports) {
    const sym = makeSymbolNode(fingerprint, e.name, e.kind, e.visibility, e.line);
    symbolNodes.push(sym);
    edges.push(
      buildEdge(fileNode.id, sym.id, EdgeKind.DeclaresSymbol, {
        visibility: e.visibility,
        declKind: e.kind,
        line: e.line,
      }),
    );
  }
  for (const l of idx.locals) {
    const sym = makeSymbolNode(fingerprint, l.name, l.kind, l.visibility, l.line);
    symbolNodes.push(sym);
    edges.push(
      buildEdge(fileNode.id, sym.id, EdgeKind.DeclaresSymbol, {
        visibility: l.visibility,
        declKind: l.kind,
        line: l.line,
      }),
    );
  }
  for (const re of idx.reExports) {
    // The target file is unresolved at extract-time; we record the spec.
    // The indexer post-pass adds the resolved symbol edge once imports
    // resolve. The placeholder symbol id below intentionally has no
    // matching node — the resolver replaces it.
    const placeholderTarget = `symbol:unresolved:${re.from}#${re.name}`;
    edges.push(
      buildEdge(fileNode.id, placeholderTarget, EdgeKind.ReExportsSymbol, {
        specifier: re.from,
        name: re.name,
        star: re.star,
        line: re.line,
      }),
    );
  }

  const rawImportSpecifiers = scanFileImports(text);
  const { importBindings, identifierReferences } = walkAst(absPath, text);

  return {
    fileNode,
    symbolNodes,
    edges,
    rawImportSpecifiers,
    importBindings,
    identifierReferences,
  };
}

function pickScriptKind(ext: string): ts.ScriptKind {
  switch (ext) {
    case '.tsx': return ts.ScriptKind.TSX;
    case '.jsx': return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs': return ts.ScriptKind.JS;
    default: return ts.ScriptKind.TS;
  }
}

/**
 * AST walk that collects:
 *   - Named + default import bindings (skip namespace + type-only).
 *   - Identifier references in the file body, flagged as `isCall` when
 *     the identifier is the callee of a `CallExpression`.
 *
 * Identifiers inside import declarations themselves are not collected —
 * they're declaration sites, not uses.
 */
function walkAst(absPath: string, text: string): {
  importBindings: readonly IImportBinding[];
  identifierReferences: readonly IIdentifierReference[];
} {
  const ext = nodePath.extname(absPath).toLowerCase();
  let sf: ts.SourceFile;
  try {
    sf = ts.createSourceFile(absPath, text, ts.ScriptTarget.Latest, true, pickScriptKind(ext));
  } catch {
    return { importBindings: [], identifierReferences: [] };
  }
  const bindings: IImportBinding[] = [];
  const refs: IIdentifierReference[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const specifier = stmt.moduleSpecifier.text;
    const clause = stmt.importClause;
    if (!clause) continue;
    if (clause.isTypeOnly) continue;
    if (clause.name) {
      bindings.push({
        localName: clause.name.text,
        importedName: 'default',
        specifier,
        isDefault: true,
        line: lineOf(sf, clause.name),
      });
    }
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const elem of clause.namedBindings.elements) {
        if (elem.isTypeOnly) continue;
        bindings.push({
          localName: elem.name.text,
          importedName: elem.propertyName ? elem.propertyName.text : elem.name.text,
          specifier,
          isDefault: false,
          line: lineOf(sf, elem),
        });
      }
    }
    // NamespaceImport (`import * as X`) intentionally skipped.
  }

  function visit(node: ts.Node): void {
    // Skip the declaration sites we already harvested.
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isIdentifier(node) && !isDeclarationName(node)) {
      refs.push({
        name: node.text,
        line: lineOf(sf, node),
        isCall: isCallCallee(node),
      });
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(sf, visit);

  // De-dupe identical (name, line, isCall) triples; a single AST often
  // visits the same identifier twice (e.g. in computed property names).
  const seen = new Set<string>();
  const dedupedRefs: IIdentifierReference[] = [];
  for (const r of refs) {
    const k = `${r.name}|${r.line}|${r.isCall ? 1 : 0}`;
    if (seen.has(k)) continue;
    seen.add(k);
    dedupedRefs.push(r);
  }
  return { importBindings: bindings, identifierReferences: dedupedRefs };
}

function isDeclarationName(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (!parent) return false;
  // The `name` of various declarations; we don't want to record those.
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isEnumMember(parent) ||
      ts.isBindingElement(parent)) &&
    parent.name === id
  ) {
    return true;
  }
  // Property accesses: `foo.bar` — `bar` is a property name, not a free
  // identifier. We DO want to capture `foo`.
  if (ts.isPropertyAccessExpression(parent) && parent.name === id) return true;
  if (ts.isQualifiedName(parent) && parent.right === id) return true;
  // Property assignment in object literal: `{ bar: x }` — `bar` is a key.
  if (ts.isPropertyAssignment(parent) && parent.name === id) return true;
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === id) {
    // `{ foo }` — `foo` is BOTH key and value; we want it.
    return false;
  }
  return false;
}

function isCallCallee(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (!parent) return false;
  if (ts.isCallExpression(parent) && parent.expression === id) return true;
  // `new Foo(...)` — semantically an invocation; count it as a call.
  if (ts.isNewExpression(parent) && parent.expression === id) return true;
  return false;
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/**
 * Stitch identifier references + import bindings into edges.
 *
 * Called by the indexer after per-file extraction + import resolution.
 * Emits `references-symbol` / `calls-symbol` edges from a file to the
 * symbol(s) it uses. Same-file references resolve against the file's
 * own declared symbols; cross-file references resolve via the import
 * bindings + the resolver's spec → targetPath map.
 *
 * Default imports target `symbol:<targetPath>#<defaultExportName>`
 * when the default export name is known (via the file node's
 * `defaultExportName` data), or `#default` as a placeholder when not.
 */
export function stitchPerFileReferences(input: {
  fileNodeId: string;
  extracted: IExtractedFile;
  /** specifier → targetFilePath (POSIX, project-relative). */
  resolvedSpec: ReadonlyMap<string, string | undefined>;
  /** targetPath → defaultExportName (if known). */
  defaultExportNameByPath: ReadonlyMap<string, string | undefined>;
  /** localName → symbol node id, restricted to this file's own symbols. */
  localSymbolNamesInThisFile: ReadonlyMap<string, string>;
}): readonly IEdge[] {
  const { fileNodeId, extracted, resolvedSpec, defaultExportNameByPath, localSymbolNamesInThisFile } = input;
  const bindings = new Map<string, string>();
  for (const b of extracted.importBindings) {
    const targetPath = resolvedSpec.get(b.specifier);
    if (!targetPath) continue;
    if (b.isDefault) {
      const defName = defaultExportNameByPath.get(targetPath);
      bindings.set(b.localName, `symbol:${targetPath}#${defName ?? 'default'}`);
    } else {
      bindings.set(b.localName, `symbol:${targetPath}#${b.importedName}`);
    }
  }
  const out: IEdge[] = [];
  const seen = new Set<string>();
  for (const r of extracted.identifierReferences) {
    let target = bindings.get(r.name);
    if (!target) target = localSymbolNamesInThisFile.get(r.name);
    if (!target) continue;
    if (target === fileNodeId) continue; // ignore self-loops
    const kind = r.isCall ? EdgeKind.CallsSymbol : EdgeKind.ReferencesSymbol;
    // De-dupe (target, kind) — many call sites of the same function on
    // different lines collapse to a single file-level edge. We keep
    // line info via the data of the first occurrence; the schema is
    // ready for symbol-level edges in Wave 3 proper.
    const edgeKey = `${target}|${kind}`;
    if (seen.has(edgeKey)) continue;
    seen.add(edgeKey);
    out.push(buildEdge(fileNodeId, target, kind, { line: r.line }));
  }
  return out;
}

function makeFileNodeForNonTs(fp: IFileFingerprint): INode {
  const label = fp.path.split('/').pop() ?? fp.path;
  const tags: string[] = [fp.language];
  if (isTestPath(fp.path)) tags.push('test');
  return {
    id: fp.nodeId,
    kind: NodeKind.File,
    label,
    path: fp.path,
    tags,
    data: {
      language: fp.language,
      sizeBytes: fp.sizeBytes,
      sha1: fp.sha1,
      hasDefaultExport: false,
      exportCount: 0,
      localCount: 0,
      reExportCount: 0,
    },
  };
}

function makeFileNode(fp: IFileFingerprint, idx: ISymbolIndex): INode {
  const label = fp.path.split('/').pop() ?? fp.path;
  const tags: string[] = [];
  if (isTestPath(fp.path)) tags.push('test');
  if (isGenerated(idx)) tags.push('generated');
  return {
    id: fp.nodeId,
    kind: NodeKind.File,
    label,
    path: fp.path,
    tags: tags.length > 0 ? tags : undefined,
    data: {
      language: fp.language,
      sizeBytes: fp.sizeBytes,
      sha1: fp.sha1,
      hasDefaultExport: idx.hasDefaultExport,
      ...(idx.defaultExportName ? { defaultExportName: idx.defaultExportName } : {}),
      exportCount: idx.exports.length,
      localCount: idx.locals.length,
      reExportCount: idx.reExports.length,
    },
  };
}

function makeSymbolNode(
  fp: IFileFingerprint,
  name: string,
  declKind: string,
  visibility: SymbolVisibility,
  line: number,
): INode {
  return {
    id: `symbol:${fp.path}#${name}`,
    kind: NodeKind.Symbol,
    label: name,
    path: fp.path,
    line,
    data: {
      declKind,
      visibility,
      isExported:
        visibility === SymbolVisibility.Export || visibility === SymbolVisibility.Default,
    },
  };
}

function buildEdge(
  from: string,
  to: string,
  kind: EdgeKind,
  data?: Readonly<Record<string, unknown>>,
): IEdge {
  const id = createHash('sha1').update(`${from}|${to}|${kind}`).digest('hex');
  return {
    id,
    from,
    to,
    kind,
    source: EXTRACT_TS_FILE_SOURCE,
    ...(data ? { data } : {}),
  };
}

function isTestPath(rel: string): boolean {
  return /(?:^|\/)(?:__tests__|__mocks__)\//.test(rel) || /\.(?:test|spec)\.[tj]sx?$/.test(rel);
}

function isGenerated(idx: ISymbolIndex): boolean {
  // Symbol-index doesn't preserve raw text; the file-level header check
  // happens in the indexer where the buffer is in hand. Stays false here
  // and is corrected by the indexer when needed.
  return false;
}

function scanFileImports(text: string): IRawImportSpecifier[] {
  const out: IRawImportSpecifier[] = [];
  collect(text, IMPORT_RE, 'static', out);
  collect(text, SIDE_EFFECT_IMPORT_RE, 'side-effect', out);
  collect(text, DYNAMIC_IMPORT_RE, 'dynamic', out);
  collect(text, REQUIRE_RE, 'require', out);
  // Dedupe identical (specifier, line, kind).
  const seen = new Set<string>();
  const deduped: IRawImportSpecifier[] = [];
  for (const it of out) {
    const k = `${it.kind}|${it.specifier}|${it.line}`;
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(it);
  }
  return deduped;
}

function collect(
  text: string,
  re: RegExp,
  kind: string,
  out: IRawImportSpecifier[],
): void {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const specifier = m[1];
    if (!specifier) continue;
    const line = lineFromOffset(text, m.index);
    out.push({ specifier, line, kind });
  }
}

function lineFromOffset(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}
