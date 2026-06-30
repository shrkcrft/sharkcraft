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

export const EXTRACT_KOTLIN_FILE_SOURCE = 'extract-kotlin-file@v1';

/**
 * Regex-based Kotlin extractor.
 *
 * Top-level constructs only. Captured:
 *   - `fun name(...)`, `inline fun`, `suspend fun` → function
 *   - `class Name`, `data class Name`, `value class Name`, `inline class Name`, `sealed class Name`, `abstract class Name`, `open class Name` → class
 *   - `interface Name`, `sealed interface Name` → interface
 *   - `object Name` → object (rendered as `class`)
 *   - `enum class Name` → enum
 *   - `typealias Name = ...` → type-alias
 *   - `val NAME: T`, `var NAME: T`, `const val NAME` → const
 *
 * Visibility: Kotlin's default is `public`. `private`, `internal`,
 * and `protected` mark a symbol as local; everything else is exported.
 */
export function extractKotlinFile(
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
    if (raw.trimStart().startsWith('//')) continue;
    // Strip leading annotations (e.g. `@Suppress("...")`, `@JvmStatic`).
    const stripped = raw.replace(/^(?:@\w+(?:\([^)]*\))?\s+)+/, '');
    // Detect visibility (default to exported).
    const visMatch = /^(public|private|internal|protected)\s+/.exec(stripped);
    const isExported = !visMatch || visMatch[1] === 'public';
    const afterVis = visMatch ? stripped.slice(visMatch[0].length) : stripped;
    // Strip declaration modifiers that don't affect the symbol shape.
    const trimmed = afterVis.replace(
      /^(?:inline\s+|suspend\s+|tailrec\s+|infix\s+|operator\s+|external\s+|open\s+|abstract\s+|final\s+|sealed\s+|data\s+|value\s+|enum\s+|annotation\s+|inner\s+|companion\s+|expect\s+|actual\s+|override\s+)+/,
      '',
    );
    // Allow an optional receiver (e.g. `String.`, `List<Int>.`) before the
    // name so extension functions are captured; the FINAL identifier is the
    // function name.
    let m = /^fun(?:\s*<[^>]+>)?\s+(?:[A-Za-z_][\w.<>,?\s]*\.)?([A-Za-z_][\w]*)\s*[<(]/.exec(trimmed);
    if (m) {
      pushSymbol(fingerprint, symbolNodes, edges, fileNode.id, m[1]!, 'function', i + 1, isExported);
      continue;
    }
    m = /^class\s+([A-Za-z_][\w]*)/.exec(trimmed);
    if (m) {
      pushSymbol(fingerprint, symbolNodes, edges, fileNode.id, m[1]!, 'class', i + 1, isExported);
      continue;
    }
    m = /^interface\s+([A-Za-z_][\w]*)/.exec(trimmed);
    if (m) {
      pushSymbol(fingerprint, symbolNodes, edges, fileNode.id, m[1]!, 'interface', i + 1, isExported);
      continue;
    }
    m = /^object\s+([A-Za-z_][\w]*)/.exec(trimmed);
    if (m) {
      pushSymbol(fingerprint, symbolNodes, edges, fileNode.id, m[1]!, 'class', i + 1, isExported);
      continue;
    }
    m = /^typealias\s+([A-Za-z_][\w]*)/.exec(trimmed);
    if (m) {
      pushSymbol(fingerprint, symbolNodes, edges, fileNode.id, m[1]!, 'type-alias', i + 1, isExported);
      continue;
    }
    m = /^(?:const\s+)?(?:val|var)\s+([A-Za-z_][\w]*)\s*[:=]/.exec(trimmed);
    if (m) {
      pushSymbol(fingerprint, symbolNodes, edges, fileNode.id, m[1]!, 'const', i + 1, isExported);
    }
  }

  return {
    fileNode,
    symbolNodes,
    edges,
    rawImportSpecifiers: scanKotlinImports(text),
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
    data: { declKind, visibility: isExported ? 'export' : 'local', isExported, language: 'kotlin' },
  };
  nodes.push(sym);
  edges.push({
    id: createHash('sha1').update(`${fileId}|${sym.id}|${EdgeKind.DeclaresSymbol}`).digest('hex'),
    from: fileId,
    to: sym.id,
    kind: EdgeKind.DeclaresSymbol,
    source: EXTRACT_KOTLIN_FILE_SOURCE,
    data: { visibility: isExported ? 'export' : 'local', declKind, line },
  });
}

function makeFileNode(fp: IFileFingerprint, text: string): INode {
  const label = fp.path.split('/').pop() ?? fp.path;
  const tags: string[] = ['kotlin'];
  if (isKotlinTestPath(fp.path)) tags.push('test');
  const packageMatch = /^package\s+([\w.]+)/m.exec(text);
  return {
    id: fp.nodeId,
    kind: NodeKind.File,
    label,
    path: fp.path,
    tags,
    data: {
      language: 'kotlin',
      sizeBytes: fp.sizeBytes,
      sha1: fp.sha1,
      hasDefaultExport: false,
      exportCount: 0,
      localCount: 0,
      reExportCount: 0,
      ...(packageMatch ? { kotlinPackage: packageMatch[1]! } : {}),
    },
  };
}

function isKotlinTestPath(rel: string): boolean {
  return (
    /(?:^|\/)src\/test\//.test(rel) ||
    /(?:^|\/)src\/.*Test\//.test(rel) ||
    /(?:^|\/)[\w-]+Test\.kts?$/.test(rel)
  );
}

function scanKotlinImports(text: string): readonly IRawImportSpecifier[] {
  const out: IRawImportSpecifier[] = [];
  // Matches `import a.b.C`, `import a.b.*`, `import a.b.C as D`.
  const re = /^import\s+([\w.]+(?:\.\*)?)(?:\s+as\s+\w+)?\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const line = lineFromOffset(text, m.index);
    out.push({ specifier: m[1]!, line, kind: 'kotlin-import' });
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
