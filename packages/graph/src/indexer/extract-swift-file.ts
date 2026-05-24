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

export const EXTRACT_SWIFT_FILE_SOURCE = 'extract-swift-file@v1';

/**
 * Regex-based Swift extractor.
 *
 * Top-level declarations only (column-0). Detected:
 *   - `[public|open|internal|fileprivate|private] [final] class Name`
 *   - `struct Name`
 *   - `enum Name`
 *   - `protocol Name`
 *   - `extension Name`
 *   - `typealias Name = …`
 *   - `func name(…)`
 *
 * Visibility: `public` / `open` → exported, otherwise local.
 *
 * Imports: `import Foundation`, `import struct CoreData.NSManagedObject`,
 * `import class UIKit.UIView` (the second form names a kind + path —
 * captured as the bare path).
 *
 * Out of scope:
 *   - `@objc` / `@available` annotations.
 *   - Class methods (the regex captures only column-0 funcs).
 */
export function extractSwiftFile(
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
    const trimmed = raw.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;
    // Strip leading `@Annotation` style attributes.
    const stripped = trimmed.replace(/^(?:@\w+(?:\([^)]*\))?\s+)+/, '');
    const visMatch = /^(public|open|internal|fileprivate|private)\s+/.exec(stripped);
    const isExported = !!visMatch && (visMatch[1] === 'public' || visMatch[1] === 'open');
    // For visibility-less declarations, Swift defaults to `internal`
    // (file-local for the module). Treat as local in graph terms.
    const explicitlyExported = isExported;
    const rest = visMatch ? stripped.slice(visMatch[0].length) : stripped;
    const noModifiers = rest.replace(
      /^(?:final\s+|indirect\s+|dynamic\s+|static\s+|class\s+(?=func|var|let)|override\s+|mutating\s+|nonisolated\s+|isolated\s+|async\s+|throws\s+)+/,
      '',
    );
    let m = /^class\s+([A-Za-z_]\w*)/.exec(noModifiers);
    if (m) {
      pushSymbol(fingerprint, symbolNodes, edges, fileNode.id, m[1]!, 'class', i + 1, explicitlyExported);
      continue;
    }
    m = /^struct\s+([A-Za-z_]\w*)/.exec(noModifiers);
    if (m) {
      pushSymbol(fingerprint, symbolNodes, edges, fileNode.id, m[1]!, 'class', i + 1, explicitlyExported);
      continue;
    }
    m = /^enum\s+([A-Za-z_]\w*)/.exec(noModifiers);
    if (m) {
      pushSymbol(fingerprint, symbolNodes, edges, fileNode.id, m[1]!, 'enum', i + 1, explicitlyExported);
      continue;
    }
    m = /^protocol\s+([A-Za-z_]\w*)/.exec(noModifiers);
    if (m) {
      pushSymbol(fingerprint, symbolNodes, edges, fileNode.id, m[1]!, 'interface', i + 1, explicitlyExported);
      continue;
    }
    m = /^extension\s+([A-Za-z_]\w*)/.exec(noModifiers);
    if (m) {
      pushSymbol(fingerprint, symbolNodes, edges, fileNode.id, m[1]!, 'class', i + 1, explicitlyExported);
      continue;
    }
    m = /^typealias\s+([A-Za-z_]\w*)/.exec(noModifiers);
    if (m) {
      pushSymbol(fingerprint, symbolNodes, edges, fileNode.id, m[1]!, 'type-alias', i + 1, explicitlyExported);
      continue;
    }
    m = /^func\s+([A-Za-z_]\w*)/.exec(noModifiers);
    if (m) {
      pushSymbol(fingerprint, symbolNodes, edges, fileNode.id, m[1]!, 'function', i + 1, explicitlyExported);
    }
  }

  return {
    fileNode,
    symbolNodes,
    edges,
    rawImportSpecifiers: scanSwiftImports(text),
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
    data: { declKind, visibility: isExported ? 'export' : 'local', isExported, language: 'swift' },
  };
  nodes.push(sym);
  edges.push({
    id: createHash('sha1').update(`${fileId}|${sym.id}|${EdgeKind.DeclaresSymbol}`).digest('hex'),
    from: fileId,
    to: sym.id,
    kind: EdgeKind.DeclaresSymbol,
    source: EXTRACT_SWIFT_FILE_SOURCE,
    data: { visibility: isExported ? 'export' : 'local', declKind, line },
  });
}

function makeFileNode(fp: IFileFingerprint): INode {
  const label = fp.path.split('/').pop() ?? fp.path;
  const tags: string[] = ['swift'];
  if (isSwiftTestPath(fp.path)) tags.push('test');
  return {
    id: fp.nodeId,
    kind: NodeKind.File,
    label,
    path: fp.path,
    tags,
    data: {
      language: 'swift',
      sizeBytes: fp.sizeBytes,
      sha1: fp.sha1,
      hasDefaultExport: false,
      exportCount: 0,
      localCount: 0,
      reExportCount: 0,
    },
  };
}

function isSwiftTestPath(rel: string): boolean {
  return (
    /(?:^|\/)Tests\//.test(rel) ||
    /(?:^|\/)[\w-]+Tests\.swift$/.test(rel)
  );
}

function scanSwiftImports(text: string): readonly IRawImportSpecifier[] {
  const out: IRawImportSpecifier[] = [];
  // `import Foundation`, `import struct CoreData.NSManagedObject`
  const re = /^import\s+(?:(?:struct|class|protocol|enum|typealias|func|let|var)\s+)?([\w.]+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const line = lineFromOffset(text, m.index);
    out.push({ specifier: m[1]!, line, kind: 'swift-import' });
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
