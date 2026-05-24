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

export const EXTRACT_JAVA_FILE_SOURCE = 'extract-java-file@v1';

/**
 * Regex-based Java extractor.
 *
 * Top-level constructs only — we don't track nested classes or class
 * members. For a fuller view a future round can layer a real Java
 * parser (`tree-sitter-java`) without changing the schema.
 *
 *   - `public class Name { … }` (and `final` / `abstract` / `sealed`
 *     modifiers in any order) → symbol (class).
 *   - `interface Name { … }` → symbol (interface).
 *   - `enum Name { … }` → symbol (enum).
 *   - `record Name(...)` → symbol (class).
 *
 * Visibility is derived from the modifier: `public` → exported,
 * anything else → local (package-private / private / protected).
 *
 * Imports: classic Java `import a.b.C;` / `import a.b.*;` /
 * `import static a.b.C.*;`. The specifier is the fully-qualified path
 * (without trailing `;`).
 */
export function extractJavaFile(
  fingerprint: IFileFingerprint,
  absPath: string,
  content?: string,
): IExtractedFile {
  const text = content ?? readFileSync(absPath, 'utf8');
  const fileNode = makeFileNode(fingerprint, text);
  const symbolNodes: INode[] = [];
  const edges: IEdge[] = [];

  // Capture top-level type declarations. Modifiers can appear in any
  // order and may include annotations (which we discard for the MVP).
  // We require the declaration starts at column 0 to keep nested
  // declarations (class bodies) out of the symbol list.
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!;
    if (raw.length === 0) continue;
    if (raw.startsWith(' ') || raw.startsWith('\t')) continue;
    if (raw.trimStart().startsWith('//')) continue;
    // Strip leading annotations like `@Override`.
    const stripped = raw.replace(/^(?:@\w+(?:\([^)]*\))?\s+)+/, '');
    const m = /^(?:public\s+|protected\s+|private\s+|static\s+|final\s+|abstract\s+|sealed\s+|non-sealed\s+)*\s*(class|interface|enum|record)\s+([A-Za-z_][\w]*)/.exec(stripped);
    if (!m) continue;
    const declKind = m[1] === 'class' || m[1] === 'record' ? 'class'
      : m[1] === 'interface' ? 'interface'
      : 'enum';
    const name = m[2]!;
    const isExported = /\bpublic\b/.test(stripped);
    pushSymbol(fingerprint, symbolNodes, edges, fileNode.id, name, declKind, i + 1, isExported);
  }

  return {
    fileNode,
    symbolNodes,
    edges,
    rawImportSpecifiers: scanJavaImports(text),
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
    data: { declKind, visibility: isExported ? 'export' : 'local', isExported, language: 'java' },
  };
  nodes.push(sym);
  edges.push({
    id: createHash('sha1').update(`${fileId}|${sym.id}|${EdgeKind.DeclaresSymbol}`).digest('hex'),
    from: fileId,
    to: sym.id,
    kind: EdgeKind.DeclaresSymbol,
    source: EXTRACT_JAVA_FILE_SOURCE,
    data: { visibility: isExported ? 'export' : 'local', declKind, line },
  });
}

function makeFileNode(fp: IFileFingerprint, text: string): INode {
  const label = fp.path.split('/').pop() ?? fp.path;
  const tags: string[] = ['java'];
  if (isJavaTestPath(fp.path)) tags.push('test');
  const packageMatch = /^package\s+([\w.]+)\s*;/m.exec(text);
  return {
    id: fp.nodeId,
    kind: NodeKind.File,
    label,
    path: fp.path,
    tags,
    data: {
      language: 'java',
      sizeBytes: fp.sizeBytes,
      sha1: fp.sha1,
      hasDefaultExport: false,
      exportCount: 0,
      localCount: 0,
      reExportCount: 0,
      ...(packageMatch ? { javaPackage: packageMatch[1]! } : {}),
    },
  };
}

function isJavaTestPath(rel: string): boolean {
  return (
    /(?:^|\/)src\/test\//.test(rel) ||
    /(?:^|\/)[\w-]+Test\.java$/.test(rel) ||
    /(?:^|\/)[\w-]+Tests\.java$/.test(rel)
  );
}

function scanJavaImports(text: string): readonly IRawImportSpecifier[] {
  const out: IRawImportSpecifier[] = [];
  const re = /^import\s+(?:static\s+)?([\w.]+(?:\.\*)?)\s*;/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const line = lineFromOffset(text, m.index);
    out.push({ specifier: m[1]!, line, kind: 'java-import' });
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
