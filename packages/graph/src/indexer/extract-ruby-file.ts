import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IEdge } from '../schema/edge.ts';
import { EdgeKind } from '../schema/edge-kind.ts';
import type { IFileFingerprint } from '../schema/file-fingerprint.ts';
import type { INode } from '../schema/node.ts';
import { NodeKind } from '../schema/node-kind.ts';
import type {
  IExtractedFile,
  IRawImportSpecifier,
} from './extract-ts-file.ts';

export const EXTRACT_RUBY_FILE_SOURCE = 'extract-ruby-file@v1';

/**
 * Regex-based Ruby extractor.
 *
 * Each regex is `^`-anchored on the trimmed line, so constructs nested
 * inside a class/module body (i.e. virtually every method) are captured
 * at any indentation — not just column-0:
 *   - `class Name` / `class Name < Base` → class symbol
 *   - `module Name` → module symbol
 *   - `def name` / `def self.name` → function symbol
 *   - `NAME = …` (uppercase identifier) → const symbol
 *
 * Ruby has no public/private declarations at the top level — every
 * symbol is treated as reachable. All emitted symbols have
 * `isExported: true` for graph consumers; the `visibility` data field
 * preserves the explicit modifier (`private` / `protected`) when one
 * precedes the def, otherwise defaults to `export`.
 *
 * Imports: `require '...'`, `require_relative '...'`, `load '...'`.
 * Specifiers are stored exactly as written, without quotes.
 *
 * Out of scope:
 *   - Method-body inspection (visibility modifiers inside class bodies
 *     toggle subsequent defs; we don't track that state here).
 *   - Mixins (`include`, `extend`, `prepend`).
 *   - Singleton classes / `class << self` blocks.
 */
export function extractRubyFile(
  fingerprint: IFileFingerprint,
  absPath: string,
  content?: string,
): IExtractedFile {
  const text = content ?? readFileSync(absPath, 'utf8');
  const fileNode = makeFileNode(fingerprint);
  const symbolNodes: INode[] = [];
  const edges: IEdge[] = [];

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!;
    if (raw.length === 0) continue;
    const trimmed = raw.trimStart();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith('#')) continue;
    // class Name [< Base]
    let m = /^class\s+([A-Z][\w:]*)/.exec(trimmed);
    if (m) {
      pushSymbol(fingerprint, symbolNodes, edges, fileNode.id, m[1]!, 'class', i + 1);
      continue;
    }
    // module Name
    m = /^module\s+([A-Z][\w:]*)/.exec(trimmed);
    if (m) {
      pushSymbol(fingerprint, symbolNodes, edges, fileNode.id, m[1]!, 'module', i + 1);
      continue;
    }
    // def name / def self.name
    m = /^def\s+(?:self\.)?([A-Za-z_][\w?!=]*)/.exec(trimmed);
    if (m) {
      pushSymbol(fingerprint, symbolNodes, edges, fileNode.id, m[1]!, 'function', i + 1);
      continue;
    }
    // Top-level CONSTANT assignment.
    m = /^([A-Z][A-Z0-9_]+)\s*=\s*/.exec(trimmed);
    if (m) {
      pushSymbol(fingerprint, symbolNodes, edges, fileNode.id, m[1]!, 'const', i + 1);
    }
  }

  return {
    fileNode,
    symbolNodes,
    edges,
    rawImportSpecifiers: scanRubyImports(text),
    importBindings: [],
    identifierReferences: [],
  };
}

function pushSymbol(
  fp: IFileFingerprint,
  nodes: INode[],
  edges: IEdge[],
  fileId: string,
  name: string,
  declKind: string,
  line: number,
): void {
  const sym: INode = {
    id: `symbol:${fp.path}#${name}`,
    kind: NodeKind.Symbol,
    label: name,
    path: fp.path,
    line,
    data: { declKind, visibility: 'export', isExported: true, language: 'ruby' },
  };
  nodes.push(sym);
  edges.push({
    id: createHash('sha1').update(`${fileId}|${sym.id}|${EdgeKind.DeclaresSymbol}`).digest('hex'),
    from: fileId,
    to: sym.id,
    kind: EdgeKind.DeclaresSymbol,
    source: EXTRACT_RUBY_FILE_SOURCE,
    data: { visibility: 'export', declKind, line },
  });
}

function makeFileNode(fp: IFileFingerprint): INode {
  const label = fp.path.split('/').pop() ?? fp.path;
  const tags: string[] = ['ruby'];
  if (isRubyTestPath(fp.path)) tags.push('test');
  return {
    id: fp.nodeId,
    kind: NodeKind.File,
    label,
    path: fp.path,
    tags,
    data: {
      language: 'ruby',
      sizeBytes: fp.sizeBytes,
      sha1: fp.sha1,
      hasDefaultExport: false,
      exportCount: 0,
      localCount: 0,
      reExportCount: 0,
    },
  };
}

function isRubyTestPath(rel: string): boolean {
  return (
    /(?:^|\/)(?:spec|test)\//.test(rel) ||
    /(?:^|\/)[\w-]+_spec\.rb$/.test(rel) ||
    /(?:^|\/)[\w-]+_test\.rb$/.test(rel)
  );
}

function scanRubyImports(text: string): readonly IRawImportSpecifier[] {
  const out: IRawImportSpecifier[] = [];
  const re = /^\s*(?:require|require_relative|load|autoload)\s+(?:["']([^"']+)["']|:[A-Za-z_]\w*\s*,\s*["']([^"']+)["'])/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const line = lineFromOffset(text, m.index);
    const specifier = m[1] ?? m[2]!;
    out.push({ specifier, line, kind: 'ruby-require' });
  }
  const seen = new Set<string>();
  const deduped: IRawImportSpecifier[] = [];
  for (const it of out) {
    const k = `${it.specifier}|${it.line}`;
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(it);
  }
  return deduped;
}

function lineFromOffset(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}
