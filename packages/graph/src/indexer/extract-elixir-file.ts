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

export const EXTRACT_ELIXIR_FILE_SOURCE = 'extract-elixir-file@v1';

/**
 * Regex-based Elixir extractor.
 *
 * Top-level constructs only (column-0):
 *   - `defmodule Path.To.Mod do` → module
 *   - `def name(...)` → function (exported)
 *   - `defp name(...)` → function (local)
 *   - `defstruct …` and `defprotocol` / `defimpl` headers → struct / protocol
 *
 * Nested `def`s under a `defmodule` show up at column 0 in this
 * extractor's view; that's intentional because they're the publicly
 * callable functions on that module.
 *
 * Imports: `alias Foo.Bar`, `alias Foo.{A, B}`, `import Enum`,
 * `require Logger`, `use MyAppWeb, :controller`. Aliases inside
 * `{...}` are expanded.
 *
 * Out of scope:
 *   - Pipe operator chains.
 *   - Macro definitions (`defmacro`/`defmacrop`).
 *   - Inline guard clauses (`when ...`).
 */
export function extractElixirFile(
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
    if (raw.length === 0) continue;
    const trimmed = raw.trimStart();
    if (trimmed.startsWith('#')) continue;
    // defmodule (can be nested under another defmodule, but we still
    // emit it as a symbol; the file may declare multiple).
    let m = /^\s*defmodule\s+([A-Z][\w.]*)\s+do/.exec(raw);
    if (m) {
      pushSymbol(fingerprint, symbolNodes, edges, fileNode.id, m[1]!, 'module', i + 1, true);
      continue;
    }
    // def / defp (top-of-line or under any indentation — we still want them).
    m = /^\s*def\s+([a-z_][\w?!]*)\s*[\(,\s]/.exec(raw);
    if (m) {
      pushSymbol(fingerprint, symbolNodes, edges, fileNode.id, m[1]!, 'function', i + 1, true);
      continue;
    }
    m = /^\s*defp\s+([a-z_][\w?!]*)\s*[\(,\s]/.exec(raw);
    if (m) {
      pushSymbol(fingerprint, symbolNodes, edges, fileNode.id, m[1]!, 'function', i + 1, false);
      continue;
    }
    m = /^\s*defprotocol\s+([A-Z][\w.]*)/.exec(raw);
    if (m) {
      pushSymbol(fingerprint, symbolNodes, edges, fileNode.id, m[1]!, 'interface', i + 1, true);
      continue;
    }
    m = /^\s*defstruct\s+/.exec(raw);
    if (m) {
      pushSymbol(fingerprint, symbolNodes, edges, fileNode.id, '__struct__', 'class', i + 1, true);
    }
  }

  return {
    fileNode,
    symbolNodes,
    edges,
    rawImportSpecifiers: scanElixirImports(text),
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
    data: { declKind, visibility: isExported ? 'export' : 'local', isExported, language: 'elixir' },
  };
  nodes.push(sym);
  edges.push({
    id: createHash('sha1').update(`${fileId}|${sym.id}|${EdgeKind.DeclaresSymbol}`).digest('hex'),
    from: fileId,
    to: sym.id,
    kind: EdgeKind.DeclaresSymbol,
    source: EXTRACT_ELIXIR_FILE_SOURCE,
    data: { visibility: isExported ? 'export' : 'local', declKind, line },
  });
}

function makeFileNode(fp: IFileFingerprint, text: string): INode {
  const label = fp.path.split('/').pop() ?? fp.path;
  const tags: string[] = ['elixir'];
  if (isElixirTestPath(fp.path)) tags.push('test');
  // Capture the first defmodule name for convenience.
  const modMatch = /^\s*defmodule\s+([A-Z][\w.]*)\s+do/m.exec(text);
  return {
    id: fp.nodeId,
    kind: NodeKind.File,
    label,
    path: fp.path,
    tags,
    data: {
      language: 'elixir',
      sizeBytes: fp.sizeBytes,
      sha1: fp.sha1,
      hasDefaultExport: false,
      exportCount: 0,
      localCount: 0,
      reExportCount: 0,
      ...(modMatch ? { elixirModule: modMatch[1]! } : {}),
    },
  };
}

function isElixirTestPath(rel: string): boolean {
  return (
    /(?:^|\/)test\//.test(rel) ||
    /(?:^|\/)[\w-]+_test\.exs?$/.test(rel)
  );
}

function scanElixirImports(text: string): readonly IRawImportSpecifier[] {
  const out: IRawImportSpecifier[] = [];
  // `alias Foo.Bar`, `alias Foo.Bar.{A, B}`, `import Foo`, `require Foo`, `use Foo, :opt`
  const re = /^\s*(alias|import|require|use)\s+([A-Z][\w.]*)(?:\.\{([^}]+)\})?/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const kind = `elixir-${m[1]!}`;
    const base = m[2]!;
    const line = lineFromOffset(text, m.index);
    if (m[3]) {
      for (const item of m[3].split(',')) {
        const part = item.trim();
        if (part) out.push({ specifier: `${base}.${part}`, line, kind });
      }
    } else {
      out.push({ specifier: base, line, kind });
    }
  }
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

function lineFromOffset(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}
