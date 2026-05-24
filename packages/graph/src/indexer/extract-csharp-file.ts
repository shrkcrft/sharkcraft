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

export const EXTRACT_CSHARP_FILE_SOURCE = 'extract-csharp-file@v1';

/**
 * Regex-based C# extractor.
 *
 * Captured (top-level only — nested types are skipped to stay tight):
 *   - `[public] class Name`, `[public] sealed class`, `[public] static
 *     class`, `[public] abstract class`, `[public] partial class`
 *   - `[public] interface Name`
 *   - `[public] struct Name`, `[public] readonly struct`
 *   - `[public] record Name(...)`, `[public] record class`, `[public]
 *     record struct`
 *   - `[public] enum Name`
 *   - `namespace Name { … }` and `namespace Name;` (file-scoped)
 *
 * Visibility: `public` → exported. `internal`/`private`/`protected`
 * → local. C# defaults to `internal` at the namespace level, so the
 * `isExported` flag honours the explicit modifier; unmodified types
 * are treated as `internal` (local).
 *
 * Imports: classic `using X.Y;`, `using static X.Y.Z;`,
 * `using alias = X.Y;`. We capture the right-hand path; aliases are
 * dropped.
 */
export function extractCsharpFile(
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
    if (raw.startsWith(' ') || raw.startsWith('\t')) continue;
    const trimmed = raw.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;
    // Strip leading attributes like `[Serializable]` or `[Obsolete("…")]`.
    const stripped = trimmed.replace(/^(?:\[[^\]]*\]\s*)+/, '');
    // Pull access modifiers + variant modifiers.
    const visMatch = /^(public|internal|private|protected|protected\s+internal|internal\s+protected|private\s+protected)\s+/.exec(stripped);
    const isExported = !!visMatch && /\bpublic\b/.test(visMatch[1]!);
    const rest = visMatch ? stripped.slice(visMatch[0].length) : stripped;
    const noModifiers = rest.replace(
      /^(?:static\s+|sealed\s+|abstract\s+|partial\s+|readonly\s+|ref\s+|unsafe\s+|new\s+|virtual\s+|override\s+|async\s+)+/,
      '',
    );
    let m = /^class\s+([A-Za-z_]\w*)/.exec(noModifiers);
    if (m) { pushSymbol(fingerprint, symbolNodes, edges, fileNode.id, m[1]!, 'class', i + 1, isExported); continue; }
    m = /^interface\s+([A-Za-z_]\w*)/.exec(noModifiers);
    if (m) { pushSymbol(fingerprint, symbolNodes, edges, fileNode.id, m[1]!, 'interface', i + 1, isExported); continue; }
    m = /^struct\s+([A-Za-z_]\w*)/.exec(noModifiers);
    if (m) { pushSymbol(fingerprint, symbolNodes, edges, fileNode.id, m[1]!, 'class', i + 1, isExported); continue; }
    m = /^record(?:\s+(?:class|struct))?\s+([A-Za-z_]\w*)/.exec(noModifiers);
    if (m) { pushSymbol(fingerprint, symbolNodes, edges, fileNode.id, m[1]!, 'class', i + 1, isExported); continue; }
    m = /^enum\s+([A-Za-z_]\w*)/.exec(noModifiers);
    if (m) { pushSymbol(fingerprint, symbolNodes, edges, fileNode.id, m[1]!, 'enum', i + 1, isExported); continue; }
    m = /^namespace\s+([\w.]+)\s*[;{]/.exec(noModifiers);
    if (m) { pushSymbol(fingerprint, symbolNodes, edges, fileNode.id, m[1]!, 'namespace', i + 1, true); }
  }

  return {
    fileNode,
    symbolNodes,
    edges,
    rawImportSpecifiers: scanUsings(text),
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
    data: { declKind, visibility: isExported ? 'export' : 'local', isExported, language: 'csharp' },
  };
  nodes.push(sym);
  edges.push({
    id: createHash('sha1').update(`${fileId}|${sym.id}|${EdgeKind.DeclaresSymbol}`).digest('hex'),
    from: fileId,
    to: sym.id,
    kind: EdgeKind.DeclaresSymbol,
    source: EXTRACT_CSHARP_FILE_SOURCE,
    data: { visibility: isExported ? 'export' : 'local', declKind, line },
  });
}

function makeFileNode(fp: IFileFingerprint, text: string): INode {
  const label = fp.path.split('/').pop() ?? fp.path;
  const tags: string[] = ['csharp'];
  if (isCsharpTestPath(fp.path)) tags.push('test');
  const nsMatch = /^namespace\s+([\w.]+)/m.exec(text);
  return {
    id: fp.nodeId,
    kind: NodeKind.File,
    label,
    path: fp.path,
    tags,
    data: {
      language: 'csharp',
      sizeBytes: fp.sizeBytes,
      sha1: fp.sha1,
      hasDefaultExport: false,
      exportCount: 0,
      localCount: 0,
      reExportCount: 0,
      ...(nsMatch ? { csharpNamespace: nsMatch[1]! } : {}),
    },
  };
}

function isCsharpTestPath(rel: string): boolean {
  return /(?:^|\/)[\w.-]+Tests?\.cs$/.test(rel) || /(?:^|\/)test\//.test(rel);
}

function scanUsings(text: string): readonly IRawImportSpecifier[] {
  const out: IRawImportSpecifier[] = [];
  // `using X.Y;`, `using static X.Y.Z;`, `using alias = X.Y.Z;`,
  // `using alias = X.Y.Generic<int, string>;`
  const re = /^using\s+(?:static\s+)?(?:[\w]+\s*=\s*)?([\w.]+)(?:\s*<[^;]*>)?\s*;/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const line = lineFromOffset(text, m.index);
    out.push({ specifier: m[1]!, line, kind: 'csharp-using' });
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
