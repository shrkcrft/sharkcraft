import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import * as ts from 'typescript';
import type { IStructuralMatch, IStructuralSearchResult } from '../schema/match.ts';
import type { StructuralPattern } from '../schema/pattern.ts';
import { matchPattern } from './match-pattern.ts';

const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.git',
  '.sharkcraft',
  '.next',
  '.cache',
  '.tmp-pack',
  'out',
  'target',
]);

export interface IRunSearchOptions {
  projectRoot: string;
  pattern: StructuralPattern;
  /** Restrict to specific project-relative files (skips the walker). */
  files?: readonly string[];
  /** Cap on returned matches. Default 500. */
  limit?: number;
}

/**
 * Run a structural pattern against a project (or a file subset). Returns
 * up to `limit` matches. Files that fail to parse get a diagnostic but
 * do not abort the search.
 */
export function runSearch(options: IRunSearchOptions): IStructuralSearchResult {
  const { projectRoot, pattern } = options;
  const limit = options.limit ?? 500;
  const targets = options.files ? options.files.map((f) => nodePath.resolve(projectRoot, f)) : walk(projectRoot);
  const matches: IStructuralMatch[] = [];
  const diagnostics: string[] = [];
  let filesScanned = 0;
  let truncated = false;
  for (const abs of targets) {
    if (truncated) break;
    filesScanned += 1;
    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    let sf: ts.SourceFile;
    try {
      sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, pickScriptKind(abs));
    } catch (e) {
      diagnostics.push(`${nodePath.relative(projectRoot, abs)}: parse failed (${(e as Error).message})`);
      continue;
    }
    const rel = nodePath.relative(projectRoot, abs).split(nodePath.sep).join('/');
    visit(sf, sf, rel, pattern, matches, limit);
    if (matches.length >= limit) {
      truncated = true;
    }
  }
  return {
    schema: 'sharkcraft.structural-search/v1',
    pattern: { kind: pattern.kind, summary: summarisePattern(pattern) },
    filesScanned,
    matchCount: matches.length,
    truncated,
    matches,
    diagnostics,
  };
}

function visit(
  node: ts.Node,
  sf: ts.SourceFile,
  relPath: string,
  pattern: StructuralPattern,
  out: IStructuralMatch[],
  limit: number,
): void {
  if (out.length >= limit) return;
  if (matchPattern(node, pattern)) {
    const start = node.getStart(sf);
    const { line, character } = sf.getLineAndCharacterOfPosition(start);
    const end = Math.min(node.getEnd(), start + 200);
    const excerpt = sf.text
      .slice(start, end)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 140);
    out.push({
      file: relPath,
      line: line + 1,
      column: character,
      nodeKind: ts.SyntaxKind[node.kind] ?? String(node.kind),
      excerpt,
    });
  }
  ts.forEachChild(node, (child) => visit(child, sf, relPath, pattern, out, limit));
}

function walk(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue;
      if (name.startsWith('.') && name !== '.') continue;
      const full = nodePath.join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!st.isFile()) continue;
      if (!SOURCE_EXTS.has(nodePath.extname(full).toLowerCase())) continue;
      out.push(full);
    }
  }
  return out.sort();
}

function pickScriptKind(absPath: string): ts.ScriptKind {
  const ext = nodePath.extname(absPath).toLowerCase();
  switch (ext) {
    case '.tsx': return ts.ScriptKind.TSX;
    case '.jsx': return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs': return ts.ScriptKind.JS;
    default: return ts.ScriptKind.TS;
  }
}

function summarisePattern(p: StructuralPattern): string {
  switch (p.kind) {
    case 'Identifier':
      return `Identifier name=${p.name ?? p.nameRegex ?? '*'}`;
    case 'StringLiteral':
      return `StringLiteral text=${p.text ?? p.textRegex ?? '*'}`;
    case 'CallExpression':
      return `CallExpression callee=${p.callee?.name ?? p.callee?.nameRegex ?? '*'}`;
    case 'NewExpression':
      return `NewExpression callee=${p.callee?.name ?? p.callee?.nameRegex ?? '*'}`;
    case 'ImportDeclaration':
      return `ImportDeclaration from=${p.from ?? p.fromRegex ?? '*'}`;
    case 'ClassDeclaration':
      return `ClassDeclaration name=${p.name ?? p.nameRegex ?? '*'} decorator=${p.hasDecoratorNamed ?? '-'}`;
    case 'Decorator':
      return `Decorator name=${p.name ?? '*'}`;
    default:
      return 'unknown';
  }
}
