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

export const EXTRACT_GO_FILE_SOURCE = 'extract-go-file@v1';

/**
 * Regex-based Go extractor.
 *
 * Top-level constructs only:
 *   - `func Name(...)` → symbol (function). Methods (`func (r *T) Name`)
 *     are captured keyed as `Receiver.Name` (e.g. `Reader.Close`) so that
 *     same-named methods on distinct receivers don't collide.
 *   - `type Name struct {...}` → symbol (struct).
 *   - `type Name interface {...}` → symbol (interface).
 *   - `type Name = ...` → symbol (type-alias).
 *
 * Imports: handles both `import "path"` and the block form
 * `import (\n "a"\n "b"\n)`. Specifiers stored without quotes.
 *
 * Visibility: Go uses leading-uppercase for exported. We tag symbols
 * with `isExported: true` when the name starts with an uppercase
 * letter, false otherwise.
 *
 * Out of scope:
 *   - Constants / vars at the package level (would need a separate pass
 *     for `var (...)` and `const (...)` blocks). MVP keeps the symbol
 *     count tight; can be added later behind a flag.
 *   - Embedded types and generic type parameters.
 */
export function extractGoFile(
  fingerprint: IFileFingerprint,
  absPath: string,
  content?: string,
): IExtractedFile {
  const text = content ?? readFileSync(absPath, 'utf8');
  const fileNode = makeFileNode(fingerprint, text);
  const symbolNodes: INode[] = [];
  const edges: IEdge[] = [];

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!;
    const line = i + 1;
    if (raw.length === 0) continue;
    if (raw.trimStart().startsWith('//')) continue;
    // func — with optional receiver `(r *T)`. Methods are keyed as
    // `Receiver.Name` so same-named methods on different receivers
    // (e.g. `Close` on a Reader and a Writer) don't collide.
    let m = /^func(?:\s*\(([^)]*)\))?\s+([A-Za-z_][\w]*)\s*[\(\[]/.exec(raw);
    if (m) {
      const methodName = m[2]!;
      const receiver = m[1] !== undefined ? receiverType(m[1]) : undefined;
      const name = receiver ? `${receiver}.${methodName}` : methodName;
      pushSymbol(fingerprint, symbolNodes, edges, fileNode.id, name, 'function', line);
      continue;
    }
    // type Name struct { … } / interface { … } / = alias.
    m = /^type\s+([A-Za-z_][\w]*)\s+(struct|interface|=)/.exec(raw);
    if (m) {
      const name = m[1]!;
      const decl = m[2] === 'struct' ? 'class' : m[2] === 'interface' ? 'interface' : 'type-alias';
      pushSymbol(fingerprint, symbolNodes, edges, fileNode.id, name, decl, line);
    }
  }

  return {
    fileNode,
    symbolNodes,
    edges,
    rawImportSpecifiers: scanGoImports(text),
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
  // Go export visibility is decided by the identifier itself; for a
  // `Receiver.Name` method key that's the final segment.
  const dot = name.lastIndexOf('.');
  const visName = dot >= 0 ? name.slice(dot + 1) : name;
  const isExported = /^[A-Z]/.test(visName);
  const sym: INode = {
    id: `symbol:${fp.path}#${name}`,
    kind: NodeKind.Symbol,
    label: name,
    path: fp.path,
    line,
    data: { declKind, visibility: isExported ? 'export' : 'local', isExported, language: 'go' },
  };
  nodes.push(sym);
  edges.push({
    id: createHash('sha1').update(`${fileId}|${sym.id}|${EdgeKind.DeclaresSymbol}`).digest('hex'),
    from: fileId,
    to: sym.id,
    kind: EdgeKind.DeclaresSymbol,
    source: EXTRACT_GO_FILE_SOURCE,
    data: { visibility: isExported ? 'export' : 'local', declKind, line },
  });
}

/**
 * Derive the receiver type from a Go method receiver clause.
 *
 * `r *Reader` → `Reader`, `w Writer` → `Writer`, `*Reader` → `Reader`,
 * `s *Stack[T]` → `Stack`. Returns undefined for an empty receiver.
 */
function receiverType(receiver: string): string | undefined {
  const trimmed = receiver.trim();
  if (trimmed.length === 0) return undefined;
  // Receiver is `varName Type` (or, rarely, just `Type`) — the type is the
  // last whitespace-separated token.
  const parts = trimmed.split(/\s+/);
  let type = parts[parts.length - 1]!;
  type = type.replace(/^\*+/, ''); // strip pointer marker
  const bracket = type.indexOf('['); // strip generic type params: Stack[T] → Stack
  if (bracket >= 0) type = type.slice(0, bracket);
  return type.length > 0 ? type : undefined;
}

function makeFileNode(fp: IFileFingerprint, text: string): INode {
  const label = fp.path.split('/').pop() ?? fp.path;
  const tags: string[] = ['go'];
  if (isGoTestPath(fp.path)) tags.push('test');
  const packageMatch = /^package\s+(\w+)/m.exec(text);
  return {
    id: fp.nodeId,
    kind: NodeKind.File,
    label,
    path: fp.path,
    tags,
    data: {
      language: 'go',
      sizeBytes: fp.sizeBytes,
      sha1: fp.sha1,
      hasDefaultExport: false,
      exportCount: 0,
      localCount: 0,
      reExportCount: 0,
      ...(packageMatch ? { goPackage: packageMatch[1]! } : {}),
    },
  };
}

function isGoTestPath(rel: string): boolean {
  return /(?:^|\/)[\w-]+_test\.go$/.test(rel);
}

function scanGoImports(text: string): readonly IRawImportSpecifier[] {
  const out: IRawImportSpecifier[] = [];
  // Single-line: import "path" or import alias "path"
  const single = /^import\s+(?:[\w.]+\s+)?"([^"\n]+)"/gm;
  let m: RegExpExecArray | null;
  while ((m = single.exec(text)) !== null) {
    const line = lineFromOffset(text, m.index);
    out.push({ specifier: m[1]!, line, kind: 'go-import' });
  }
  // Block form: import (\n  "a"\n  alias "b"\n)
  const block = /^import\s*\(([^)]*)\)/gms;
  while ((m = block.exec(text)) !== null) {
    const body = m[1]!;
    const startLine = lineFromOffset(text, m.index);
    const bodyLines = body.split('\n');
    for (let i = 0; i < bodyLines.length; i += 1) {
      const ln = bodyLines[i]!.trim();
      if (!ln || ln.startsWith('//')) continue;
      const inner = /^(?:[\w.]+\s+)?"([^"]+)"/.exec(ln);
      if (inner) out.push({ specifier: inner[1]!, line: startLine + i, kind: 'go-import' });
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
