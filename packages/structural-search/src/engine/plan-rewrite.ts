import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import * as ts from 'typescript';
import {
  STRUCTURAL_REWRITE_SCHEMA,
  type IEdit,
  type IFileEdits,
  type IRewritePlan,
  type RewriteRecipe,
} from '../schema/rewrite.ts';
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

export interface IPlanRewriteOptions {
  projectRoot: string;
  pattern: StructuralPattern;
  recipe: RewriteRecipe;
  /** Restrict to specific project-relative files. */
  files?: readonly string[];
  /** Cap on returned edits per file. Default 200. */
  perFileLimit?: number;
  /** Cap on total files included in the plan. Default 5000. */
  fileLimit?: number;
}

/**
 * Compute a rewrite plan: per-file edits keyed by character offset.
 *
 * Pure function — does NOT touch disk. `applyRewritePlan` (sibling)
 * is the only write step, and it requires a plan as input.
 */
export function planRewrite(options: IPlanRewriteOptions): IRewritePlan {
  const perFileLimit = options.perFileLimit ?? 200;
  const fileLimit = options.fileLimit ?? 5000;
  const diagnostics: string[] = [];
  validatePatternRecipeMatch(options.pattern, options.recipe, diagnostics);

  const targets = options.files
    ? options.files.map((f) => nodePath.resolve(options.projectRoot, f)).slice(0, fileLimit)
    : walk(options.projectRoot).slice(0, fileLimit);

  const files: IFileEdits[] = [];
  let totalEdits = 0;
  let filesScanned = 0;
  for (const abs of targets) {
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
      diagnostics.push(`${nodePath.relative(options.projectRoot, abs)}: parse failed (${(e as Error).message})`);
      continue;
    }
    const rel = nodePath.relative(options.projectRoot, abs).split(nodePath.sep).join('/');
    const edits: IEdit[] = [];
    visit(sf, sf, options.pattern, options.recipe, edits, perFileLimit);
    if (edits.length === 0) continue;
    // Sort by start ascending (also the order the visitor produced
    // them — depth-first, so this is essentially a no-op but defensive).
    edits.sort((a, b) => a.start - b.start);
    files.push({ path: rel, edits });
    totalEdits += edits.length;
  }
  return {
    schema: STRUCTURAL_REWRITE_SCHEMA,
    pattern: options.pattern,
    recipe: options.recipe,
    filesScanned,
    totalEdits,
    files,
    diagnostics,
  };
}

function visit(
  node: ts.Node,
  sf: ts.SourceFile,
  pattern: StructuralPattern,
  recipe: RewriteRecipe,
  edits: IEdit[],
  perFileLimit: number,
): void {
  if (edits.length >= perFileLimit) return;
  if (matchPattern(node, pattern)) {
    const edit = applyRecipe(node, sf, recipe);
    if (edit) edits.push(edit);
  }
  ts.forEachChild(node, (child) => visit(child, sf, pattern, recipe, edits, perFileLimit));
}

function applyRecipe(node: ts.Node, sf: ts.SourceFile, recipe: RewriteRecipe): IEdit | undefined {
  switch (recipe.kind) {
    case 'replace-identifier-name': {
      if (!ts.isIdentifier(node)) return undefined;
      return makeEdit(sf, node.getStart(sf), node.getEnd(), recipe.to);
    }
    case 'replace-call-callee': {
      if (!ts.isCallExpression(node)) return undefined;
      const callee = node.expression;
      if (ts.isIdentifier(callee)) {
        return makeEdit(sf, callee.getStart(sf), callee.getEnd(), recipe.to);
      }
      if (ts.isPropertyAccessExpression(callee)) {
        return makeEdit(sf, callee.getStart(sf), callee.getEnd(), recipe.to);
      }
      return undefined;
    }
    case 'replace-import-from': {
      if (!ts.isImportDeclaration(node)) return undefined;
      const spec = node.moduleSpecifier;
      if (!ts.isStringLiteral(spec)) return undefined;
      // Replace just the inner string; preserve the quote characters.
      const start = spec.getStart(sf) + 1;
      const end = spec.getEnd() - 1;
      return makeEdit(sf, start, end, recipe.to);
    }
    default:
      return undefined;
  }
}

function makeEdit(sf: ts.SourceFile, start: number, end: number, replacement: string): IEdit {
  const before = sf.text.slice(start, end);
  if (before === replacement) {
    // No-op edit; skip.
    return { start, end, replacement, before, line: 0 };
  }
  const lineNo = sf.getLineAndCharacterOfPosition(start).line + 1;
  return { start, end, replacement, before, line: lineNo };
}

function validatePatternRecipeMatch(
  pattern: StructuralPattern,
  recipe: RewriteRecipe,
  diagnostics: string[],
): void {
  const expected: Record<RewriteRecipe['kind'], StructuralPattern['kind']> = {
    'replace-identifier-name': 'Identifier',
    'replace-call-callee': 'CallExpression',
    'replace-import-from': 'ImportDeclaration',
  };
  const want = expected[recipe.kind];
  if (want !== pattern.kind) {
    diagnostics.push(
      `recipe "${recipe.kind}" expects pattern kind "${want}" but got "${pattern.kind}" — no edits will be produced`,
    );
  }
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
