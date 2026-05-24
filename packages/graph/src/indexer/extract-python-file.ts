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

export const EXTRACT_PYTHON_FILE_SOURCE = 'extract-python-file@v1';

/**
 * Regex-based Python extractor.
 *
 * Module-level constructs only — no class/function body inspection, no
 * cross-reference resolution. The output matches the TS extractor's
 * `IExtractedFile` shape so the indexer can dispatch by language
 * without branching downstream.
 *
 * What we extract:
 *   - `def NAME(...)` at column 0 → symbol (function).
 *   - `class NAME(...)` at column 0 → symbol (class).
 *   - Top-level CONSTANT_LIKE assignments → symbol (const-ish). Filter:
 *     identifier is UPPERCASE and at column 0.
 *   - `import X` / `import X as Y` / `from X import ...` (including
 *     relative `.` / `..`) → raw import specifiers. Resolution to a
 *     project-relative file is deferred — Python's import resolution
 *     depends on `sys.path`, which we don't model in the MVP.
 *
 * What we don't extract (yet):
 *   - Decorators (FastAPI / Flask / Django routes are framework-scanner
 *     territory).
 *   - Async functions vs sync (treated identically — both `def`).
 *   - Nested defs / classes.
 *   - Type aliases / TypeVar / NewType.
 */
export function extractPythonFile(
  fingerprint: IFileFingerprint,
  absPath: string,
  content?: string,
): IExtractedFile {
  const text = content ?? readFileSync(absPath, 'utf8');
  const fileNode = makeFileNode(fingerprint);
  const symbolNodes: INode[] = [];
  const edges: IEdge[] = [];

  // Strip line-leading `#` comments for symbol/import detection so we
  // don't pick up `def foo` inside a docstring or comment. (Multi-line
  // string literals are still a hazard — out of scope for the MVP.)
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!;
    const line = i + 1;
    if (raw.length === 0) continue;
    if (raw[0] === '#') continue; // full-line comment
    // Module-level `def NAME(...)`.
    let m = /^def\s+([A-Za-z_][\w]*)\s*\(/.exec(raw);
    if (m) {
      const sym = makeSymbol(fingerprint, m[1]!, 'function', line);
      symbolNodes.push(sym);
      edges.push(buildEdge(fileNode.id, sym.id, EdgeKind.DeclaresSymbol, {
        visibility: 'export',
        declKind: 'function',
        line,
      }));
      continue;
    }
    m = /^async\s+def\s+([A-Za-z_][\w]*)\s*\(/.exec(raw);
    if (m) {
      const sym = makeSymbol(fingerprint, m[1]!, 'function', line);
      symbolNodes.push(sym);
      edges.push(buildEdge(fileNode.id, sym.id, EdgeKind.DeclaresSymbol, {
        visibility: 'export',
        declKind: 'function',
        line,
      }));
      continue;
    }
    // Module-level `class NAME(...)` or `class NAME:`.
    m = /^class\s+([A-Za-z_][\w]*)\s*[\(:]/.exec(raw);
    if (m) {
      const sym = makeSymbol(fingerprint, m[1]!, 'class', line);
      symbolNodes.push(sym);
      edges.push(buildEdge(fileNode.id, sym.id, EdgeKind.DeclaresSymbol, {
        visibility: 'export',
        declKind: 'class',
        line,
      }));
      continue;
    }
    // Module-level UPPERCASE constant assignment.
    m = /^([A-Z][A-Z0-9_]+)\s*(?::[^=]+)?=\s*/.exec(raw);
    if (m) {
      const sym = makeSymbol(fingerprint, m[1]!, 'const', line);
      symbolNodes.push(sym);
      edges.push(buildEdge(fileNode.id, sym.id, EdgeKind.DeclaresSymbol, {
        visibility: 'export',
        declKind: 'const',
        line,
      }));
    }
  }

  const rawImportSpecifiers = scanPythonImports(text);

  return {
    fileNode,
    symbolNodes,
    edges,
    rawImportSpecifiers,
    importBindings: [],
    identifierReferences: [],
  };
}

function makeFileNode(fp: IFileFingerprint): INode {
  const label = fp.path.split('/').pop() ?? fp.path;
  const tags: string[] = ['python'];
  if (isPythonTestPath(fp.path)) tags.push('test');
  return {
    id: fp.nodeId,
    kind: NodeKind.File,
    label,
    path: fp.path,
    tags,
    data: {
      language: 'python',
      sizeBytes: fp.sizeBytes,
      sha1: fp.sha1,
      hasDefaultExport: false,
      exportCount: 0,
      localCount: 0,
      reExportCount: 0,
    },
  };
}

function makeSymbol(
  fp: IFileFingerprint,
  name: string,
  declKind: string,
  line: number,
): INode {
  return {
    id: `symbol:${fp.path}#${name}`,
    kind: NodeKind.Symbol,
    label: name,
    path: fp.path,
    line,
    data: {
      declKind,
      visibility: 'export',
      isExported: true,
      language: 'python',
    },
  };
}

function buildEdge(
  from: string,
  to: string,
  kind: EdgeKind,
  data?: Readonly<Record<string, unknown>>,
): IEdge {
  return {
    id: createHash('sha1').update(`${from}|${to}|${kind}`).digest('hex'),
    from,
    to,
    kind,
    source: EXTRACT_PYTHON_FILE_SOURCE,
    ...(data ? { data } : {}),
  };
}

function isPythonTestPath(rel: string): boolean {
  // Common Python conventions: test_<x>.py, <x>_test.py, files under tests/.
  return (
    /(?:^|\/)(?:tests?|test)\//.test(rel) ||
    /(?:^|\/)test_[\w-]+\.py$/.test(rel) ||
    /(?:^|\/)[\w-]+_test\.py$/.test(rel)
  );
}

function scanPythonImports(text: string): readonly IRawImportSpecifier[] {
  const out: IRawImportSpecifier[] = [];
  // `from X import Y, Z` (X may include dots: `.relative`, `..parent`, `pkg.sub`)
  const fromRe = /^from\s+([.\w]+)\s+import\s+/gm;
  // `import X` or `import X as Y` or `import X, Y, Z`
  const importRe = /^import\s+([.\w]+(?:\s*,\s*[.\w]+)*)/gm;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(text)) !== null) {
    const line = lineFromOffset(text, m.index);
    out.push({ specifier: m[1]!, line, kind: 'from-import' });
  }
  while ((m = importRe.exec(text)) !== null) {
    const line = lineFromOffset(text, m.index);
    const list = m[1]!;
    for (const single of list.split(',')) {
      const name = single.trim().split(/\s+/)[0]!;
      if (name) out.push({ specifier: name, line, kind: 'import' });
    }
  }
  // De-dupe identical (specifier, line, kind).
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
