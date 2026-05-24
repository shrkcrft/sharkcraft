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

export const EXTRACT_DART_FILE_SOURCE = 'extract-dart-file@v1';

/**
 * Regex-based Dart extractor.
 *
 * Top-level declarations only (column-0). Detected:
 *   - `[abstract] class Name [extends X] [with M] [implements I]`
 *   - `mixin Name`, `mixin Name on X`
 *   - `enum Name { … }`
 *   - `typedef Name = …`
 *   - `extension Name on X { … }`
 *   - `[Type] name(…) { … }`, `void name(…) { … }` — file-scope functions
 *
 * Imports: `import 'package:foo/bar.dart' [as X] [show A, B] [hide C]`;
 * `export 'package:foo/bar.dart'`. Relative imports captured as-is.
 *
 * Visibility: Dart marks private members with a leading underscore.
 * Public symbols (no leading `_`) get `isExported: true`; otherwise
 * `local`.
 *
 * Out of scope:
 *   - `part of` / `part` directive handling.
 *   - Inline `@Annotation()` capture.
 *   - Class body walking (methods).
 */
export function extractDartFile(
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
    // class / abstract class / sealed class / interface class / final class / base class / mixin class
    let m = /^(?:abstract\s+|sealed\s+|base\s+|interface\s+|final\s+|mixin\s+)*class\s+([A-Za-z_]\w*)/.exec(trimmed);
    if (m) {
      pushSymbol(fingerprint, symbolNodes, edges, fileNode.id, m[1]!, 'class', i + 1);
      continue;
    }
    m = /^mixin\s+([A-Za-z_]\w*)/.exec(trimmed);
    if (m) {
      pushSymbol(fingerprint, symbolNodes, edges, fileNode.id, m[1]!, 'class', i + 1);
      continue;
    }
    m = /^enum\s+([A-Za-z_]\w*)/.exec(trimmed);
    if (m) {
      pushSymbol(fingerprint, symbolNodes, edges, fileNode.id, m[1]!, 'enum', i + 1);
      continue;
    }
    m = /^typedef\s+([A-Za-z_]\w*)/.exec(trimmed);
    if (m) {
      pushSymbol(fingerprint, symbolNodes, edges, fileNode.id, m[1]!, 'type-alias', i + 1);
      continue;
    }
    m = /^extension\s+([A-Za-z_]\w*)/.exec(trimmed);
    if (m) {
      pushSymbol(fingerprint, symbolNodes, edges, fileNode.id, m[1]!, 'class', i + 1);
      continue;
    }
    // File-scope functions: `<Type> name(…)` or `void name(…)`.
    // Require either a `{` to open a body (anywhere on the line) or
    // an arrow `=>` so we don't sweep up variable declarations or
    // function-type fields.
    m = /^([A-Za-z_]\w*(?:<[^>]*>)?\??)\s+([A-Za-z_]\w*)\s*\(/.exec(trimmed);
    if (m && (/\{/.test(trimmed) || /=>/.test(trimmed))) {
      const name = m[2]!;
      // Skip constructor-style names that begin with `Type.` (those are
      // class members, not file-scope functions).
      if (!name.includes('.')) {
        pushSymbol(fingerprint, symbolNodes, edges, fileNode.id, name, 'function', i + 1);
      }
    }
  }

  return {
    fileNode,
    symbolNodes,
    edges,
    rawImportSpecifiers: scanDartImports(text),
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
  const isExported = !name.startsWith('_');
  const sym: INode = {
    id: `symbol:${fp.path}#${name}`,
    kind: NodeKind.Symbol,
    label: name,
    path: fp.path,
    line,
    data: { declKind, visibility: isExported ? 'export' : 'local', isExported, language: 'dart' },
  };
  nodes.push(sym);
  edges.push({
    id: createHash('sha1').update(`${fileId}|${sym.id}|${EdgeKind.DeclaresSymbol}`).digest('hex'),
    from: fileId,
    to: sym.id,
    kind: EdgeKind.DeclaresSymbol,
    source: EXTRACT_DART_FILE_SOURCE,
    data: { visibility: isExported ? 'export' : 'local', declKind, line },
  });
}

function makeFileNode(fp: IFileFingerprint): INode {
  const label = fp.path.split('/').pop() ?? fp.path;
  const tags: string[] = ['dart'];
  if (isDartTestPath(fp.path)) tags.push('test');
  return {
    id: fp.nodeId,
    kind: NodeKind.File,
    label,
    path: fp.path,
    tags,
    data: {
      language: 'dart',
      sizeBytes: fp.sizeBytes,
      sha1: fp.sha1,
      hasDefaultExport: false,
      exportCount: 0,
      localCount: 0,
      reExportCount: 0,
    },
  };
}

function isDartTestPath(rel: string): boolean {
  return (
    /(?:^|\/)test\//.test(rel) ||
    /(?:^|\/)[\w-]+_test\.dart$/.test(rel)
  );
}

function scanDartImports(text: string): readonly IRawImportSpecifier[] {
  const out: IRawImportSpecifier[] = [];
  // `import 'package:foo/bar.dart' [as X] [show A] [hide B];`
  // `export 'package:foo/bar.dart';`
  const re = /^\s*(import|export)\s+['"]([^'"]+)['"](?:\s+(?:as\s+\w+|show\s+[^;]+|hide\s+[^;]+|deferred\s+as\s+\w+))*\s*;/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const line = lineFromOffset(text, m.index);
    out.push({ specifier: m[2]!, line, kind: `dart-${m[1]!}` });
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
