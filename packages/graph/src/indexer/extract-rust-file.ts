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

export const EXTRACT_RUST_FILE_SOURCE = 'extract-rust-file@v1';

/**
 * Regex-based Rust extractor.
 *
 * Top-level items only (column-0). Captured:
 *   - `[pub] fn name`, `[pub] async fn name` → function
 *   - `[pub] struct Name`, `[pub] enum Name`, `[pub] trait Name` → class-shaped
 *   - `[pub] type Name = ...` → type-alias
 *   - `[pub] const NAME: T = …`, `[pub] static NAME: T = …` → const
 *   - `[pub] mod name { … }` → module
 *
 * Visibility is derived from the presence of a `pub` keyword (incl.
 * `pub(crate)`, `pub(super)`, `pub(in path::to)`). Items with `pub` →
 * `isExported: true`; everything else is local.
 *
 * Imports: `use a::b::{c, d};` → one specifier per fully-qualified
 * path. `use a::b::*` is captured as `a::b::*`.
 *
 * Out of scope:
 *   - `impl` blocks (members live inside; we don't walk bodies).
 *   - Macros (`macro_rules!`), `cfg(...)`-gated items.
 *   - Item-level attributes other than `pub`.
 */
export function extractRustFile(
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
    if (raw.startsWith(' ') || raw.startsWith('\t')) continue;
    if (raw.trimStart().startsWith('//')) continue;
    // Strip a `pub` (with optional restricted `pub(crate)` style) plus
    // any `async`/`unsafe`/`extern "C"` modifiers before the declaration
    // keyword.
    const pubMatch = /^(pub(?:\s*\([^)]+\))?\s+)?/.exec(raw)!;
    const isExported = !!pubMatch[1];
    const rest = raw.slice(pubMatch[0]!.length);
    const trimmed = rest.replace(/^(?:async\s+|unsafe\s+|const\s+(?=fn\b)|extern(?:\s+"[^"]+")?\s+)+/, '');
    let m = /^fn\s+([A-Za-z_][\w]*)\s*[<(]/.exec(trimmed);
    if (m) {
      pushSymbol(fingerprint, symbolNodes, edges, fileNode.id, m[1]!, 'function', i + 1, isExported);
      continue;
    }
    m = /^(struct|enum|trait|union)\s+([A-Za-z_][\w]*)/.exec(trimmed);
    if (m) {
      const kind = m[1] === 'trait' ? 'interface' : 'class';
      pushSymbol(fingerprint, symbolNodes, edges, fileNode.id, m[2]!, kind, i + 1, isExported);
      continue;
    }
    m = /^type\s+([A-Za-z_][\w]*)\s*[=<]/.exec(trimmed);
    if (m) {
      pushSymbol(fingerprint, symbolNodes, edges, fileNode.id, m[1]!, 'type-alias', i + 1, isExported);
      continue;
    }
    m = /^(?:const|static)\s+([A-Za-z_][\w]*)\s*:/.exec(trimmed);
    if (m) {
      pushSymbol(fingerprint, symbolNodes, edges, fileNode.id, m[1]!, 'const', i + 1, isExported);
      continue;
    }
    m = /^mod\s+([A-Za-z_][\w]*)\s*[{;]/.exec(trimmed);
    if (m) {
      pushSymbol(fingerprint, symbolNodes, edges, fileNode.id, m[1]!, 'module', i + 1, isExported);
    }
  }

  return {
    fileNode,
    symbolNodes,
    edges,
    rawImportSpecifiers: scanRustImports(text),
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
  isExported: boolean,
): void {
  const sym: INode = {
    id: `symbol:${fp.path}#${name}`,
    kind: NodeKind.Symbol,
    label: name,
    path: fp.path,
    line,
    data: { declKind, visibility: isExported ? 'export' : 'local', isExported, language: 'rust' },
  };
  nodes.push(sym);
  edges.push({
    id: createHash('sha1').update(`${fileId}|${sym.id}|${EdgeKind.DeclaresSymbol}`).digest('hex'),
    from: fileId,
    to: sym.id,
    kind: EdgeKind.DeclaresSymbol,
    source: EXTRACT_RUST_FILE_SOURCE,
    data: { visibility: isExported ? 'export' : 'local', declKind, line },
  });
}

function makeFileNode(fp: IFileFingerprint): INode {
  const label = fp.path.split('/').pop() ?? fp.path;
  const tags: string[] = ['rust'];
  if (isRustTestPath(fp.path)) tags.push('test');
  return {
    id: fp.nodeId,
    kind: NodeKind.File,
    label,
    path: fp.path,
    tags,
    data: {
      language: 'rust',
      sizeBytes: fp.sizeBytes,
      sha1: fp.sha1,
      hasDefaultExport: false,
      exportCount: 0,
      localCount: 0,
      reExportCount: 0,
    },
  };
}

function isRustTestPath(rel: string): boolean {
  return /(?:^|\/)tests\//.test(rel) || /(?:^|\/)[\w-]+_test\.rs$/.test(rel);
}

/**
 * Parse `use` declarations. Supports:
 *   - `use a::b::c;`
 *   - `use a::b::{c, d, e as f};`
 *   - `use a::b::*;`
 *
 * Each leaf in the brace group emits its own specifier with the prefix
 * folded in. Aliases (`x as y`) are dropped — we keep the imported
 * path.
 */
function scanRustImports(text: string): readonly IRawImportSpecifier[] {
  const out: IRawImportSpecifier[] = [];
  // Match `use <path>(::{...})?;` allowing newlines inside `{...}`.
  const useRe = /^use\s+([\s\S]+?);/gm;
  let m: RegExpExecArray | null;
  while ((m = useRe.exec(text)) !== null) {
    // The greedy regex above would also match `use foo;\nuse bar;` as
    // a single block. Detect that and bail.
    const body = m[1]!;
    if (body.startsWith('use')) continue;
    const line = lineFromOffset(text, m.index);
    const brace = body.indexOf('::{');
    if (brace < 0) {
      // Strip optional `as Alias` and any whitespace.
      const path = body.trim().split(/\s+as\s+/)[0]!.trim();
      out.push({ specifier: path, line, kind: 'rust-use' });
    } else {
      const prefix = body.slice(0, brace).trim();
      const closeIdx = body.lastIndexOf('}');
      const inside = body.slice(brace + 3, closeIdx >= 0 ? closeIdx : body.length);
      for (const item of inside.split(',')) {
        const cleaned = item.trim().split(/\s+as\s+/)[0]!.trim();
        if (cleaned) out.push({ specifier: `${prefix}::${cleaned}`, line, kind: 'rust-use' });
      }
    }
  }
  // De-dupe.
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
