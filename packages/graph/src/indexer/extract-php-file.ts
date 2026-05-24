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

export const EXTRACT_PHP_FILE_SOURCE = 'extract-php-file@v1';

/**
 * Regex-based PHP extractor.
 *
 * Top-level declarations only (after `namespace … {` or at the file's
 * top level). Detected:
 *   - `namespace Path\Sub`             → namespace symbol
 *   - `[abstract|final|readonly] class Name` → class
 *   - `interface Name`                 → interface
 *   - `trait Name`                     → class (treated like a mixin)
 *   - `enum Name`                      → enum
 *   - `function name(…)`               → function (file-scope)
 *
 * Imports: `use Path\To\Class;`, `use Path\To\{A, B as C};`,
 * `use function Foo\bar`, `use const Foo\BAR`.
 *
 * Visibility: PHP requires `class` modifiers on declarations; we
 * derive `isExported` from the absence of `private`/`protected`.
 * Class-internal methods are NOT walked here — those live in their
 * class's body, which the framework-scanner can inspect when it
 * needs to.
 */
export function extractPhpFile(
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
    if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('/*')) continue;

    // namespace Path\Sub;  OR  namespace Path\Sub { ... }
    let m = /^namespace\s+([\w\\]+)/.exec(trimmed);
    if (m) {
      pushSymbol(fingerprint, symbolNodes, edges, fileNode.id, m[1]!, 'namespace', i + 1, true);
      continue;
    }
    // Strip attributes `#[Attr]` (PHP 8 attributes).
    const stripped = trimmed.replace(/^(?:#\[[^\]]*\]\s*)+/, '');
    // class / interface / trait / enum, allowing modifiers in any order
    m = /^(?:abstract\s+|final\s+|readonly\s+)*\s*(class|interface|trait|enum)\s+([A-Za-z_]\w*)/.exec(stripped);
    if (m) {
      const declKind = m[1] === 'interface' ? 'interface'
        : m[1] === 'enum' ? 'enum'
        : 'class';
      pushSymbol(fingerprint, symbolNodes, edges, fileNode.id, m[2]!, declKind, i + 1, true);
      continue;
    }
    // File-level `function name(...)` (not class methods).
    if (raw.startsWith('function ') || stripped.startsWith('function ')) {
      m = /^function\s+([A-Za-z_]\w*)\s*\(/.exec(stripped);
      if (m && !raw.startsWith(' ') && !raw.startsWith('\t')) {
        pushSymbol(fingerprint, symbolNodes, edges, fileNode.id, m[1]!, 'function', i + 1, true);
      }
    }
  }

  return {
    fileNode,
    symbolNodes,
    edges,
    rawImportSpecifiers: scanPhpImports(text),
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
    data: { declKind, visibility: isExported ? 'export' : 'local', isExported, language: 'php' },
  };
  nodes.push(sym);
  edges.push({
    id: createHash('sha1').update(`${fileId}|${sym.id}|${EdgeKind.DeclaresSymbol}`).digest('hex'),
    from: fileId,
    to: sym.id,
    kind: EdgeKind.DeclaresSymbol,
    source: EXTRACT_PHP_FILE_SOURCE,
    data: { visibility: isExported ? 'export' : 'local', declKind, line },
  });
}

function makeFileNode(fp: IFileFingerprint, text: string): INode {
  const label = fp.path.split('/').pop() ?? fp.path;
  const tags: string[] = ['php'];
  if (isPhpTestPath(fp.path)) tags.push('test');
  const nsMatch = /^namespace\s+([\w\\]+)/m.exec(text);
  return {
    id: fp.nodeId,
    kind: NodeKind.File,
    label,
    path: fp.path,
    tags,
    data: {
      language: 'php',
      sizeBytes: fp.sizeBytes,
      sha1: fp.sha1,
      hasDefaultExport: false,
      exportCount: 0,
      localCount: 0,
      reExportCount: 0,
      ...(nsMatch ? { phpNamespace: nsMatch[1]! } : {}),
    },
  };
}

function isPhpTestPath(rel: string): boolean {
  return (
    /(?:^|\/)(?:tests|test)\//.test(rel) ||
    /(?:^|\/)[\w-]+Test\.php$/.test(rel) ||
    /(?:^|\/)[\w-]+\.test\.php$/.test(rel)
  );
}

function scanPhpImports(text: string): readonly IRawImportSpecifier[] {
  const out: IRawImportSpecifier[] = [];
  // `use Path\To\Class;`, `use Path\To\Class as Alias;`,
  // `use function Path\to\fn;`, `use const Path\TO\CONST;`,
  // `use Path\To\{A, B as C};`
  const re = /^\s*use\s+(?:function\s+|const\s+)?([\w\\]+)(?:\s*\\?\{([^}]+)\})?(?:\s+as\s+\w+)?\s*;/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const line = lineFromOffset(text, m.index);
    const base = m[1]!.replace(/\\$/, '');
    if (m[2]) {
      for (const item of m[2].split(',')) {
        const cleaned = item.trim().split(/\s+as\s+/)[0]!.trim();
        if (cleaned) out.push({ specifier: `${base}\\${cleaned}`, line, kind: 'php-use' });
      }
    } else {
      out.push({ specifier: base, line, kind: 'php-use' });
    }
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
