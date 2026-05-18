/**
 * Template body inference v2.
 *
 * Strategy:
 *   1. Try to use the TypeScript compiler API (typescript dep). This gives us
 *      reliable class/function/component/decorator detection.
 *   2. If the import fails, fall back to a small "lightweight" analyzer that
 *      avoids regexes for structural parts and uses bracket counting.
 *   3. If even that fails, fall back to the v1 regex scaffolder.
 *
 * Output mirrors `IInferredTemplateScaffold` from v1 but adds a `provenance`
 * field (`'ast' | 'lightweight' | 'regex'`) and an explicit
 * `confidenceReasons` list. Pure: no IO outside reading the sample file.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { Node as TsNode, Decorator as TsDecorator } from 'typescript';
import { inferTemplateBody } from './template-body-inference.ts';
import type {
  IInferTemplateBodyOptions,
  IInferTemplateBodyResult,
  IInferredTemplateScaffold,
} from './template-body-inference.ts';

export type TemplateInferenceProvenance = 'ast' | 'lightweight' | 'regex';

export interface IInferredTemplateScaffoldV2 extends IInferredTemplateScaffold {
  provenance: TemplateInferenceProvenance;
  confidenceReasons: readonly string[];
  /** Decorators detected on the primary class (TS API only). */
  decorators: readonly string[];
  /** JSDoc on the primary class/function (best-effort). */
  jsdoc?: string;
  /** Public method signatures (TS API only). */
  publicMethods: readonly string[];
}

export interface IInferTemplateBodyV2Result {
  scaffold: IInferredTemplateScaffoldV2 | null;
  reason?: string;
  provenance: TemplateInferenceProvenance | 'skipped';
}

const DEFAULT_MAX_BYTES = 20_000;
const DEFAULT_MAX_LINES = 200;
const MAX_DOMAIN_LITERALS = 12;

/** Try to import the TypeScript compiler. Returns null if it isn't installed. */
async function loadTypescript(): Promise<typeof import('typescript') | null> {
  try {
    const ts = (await import('typescript')) as typeof import('typescript');
    return ts;
  } catch {
    return null;
  }
}

export async function inferTemplateBodyV2(
  options: IInferTemplateBodyOptions,
): Promise<IInferTemplateBodyV2Result> {
  const full = nodePath.isAbsolute(options.sample)
    ? options.sample
    : nodePath.join(options.projectRoot, options.sample);
  if (!existsSync(full)) {
    return {
      scaffold: null,
      reason: `sample not found: ${options.sample}`,
      provenance: 'skipped',
    };
  }
  const stat = statSync(full);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  if (stat.size > maxBytes) {
    return {
      scaffold: null,
      reason: `sample too large (${stat.size} > ${maxBytes} bytes)`,
      provenance: 'skipped',
    };
  }
  const raw = readFileSync(full, 'utf8');
  const lineCount = raw.split(/\r?\n/).length;
  if (lineCount > maxLines) {
    return {
      scaffold: null,
      reason: `sample too long (${lineCount} > ${maxLines} lines)`,
      provenance: 'skipped',
    };
  }
  const literals = countDomainLiterals(raw);
  if (literals > MAX_DOMAIN_LITERALS) {
    return {
      scaffold: null,
      reason: `sample contains ${literals} string literals — too domain-specific to scaffold`,
      provenance: 'skipped',
    };
  }
  if (hasSideEffectfulTopLevel(raw)) {
    return {
      scaffold: null,
      reason: 'sample has side-effectful top-level code — refusing to scaffold',
      provenance: 'skipped',
    };
  }

  // Try AST first.
  const ts = await loadTypescript();
  if (ts) {
    const ast = analyzeWithTypescript(ts, raw, full);
    if (ast.success) {
      return buildScaffold({
        provenance: 'ast',
        analysis: ast,
        options,
        full,
        raw,
      });
    }
  }
  // Lightweight fallback.
  const light = analyzeLightweight(raw);
  if (light.success) {
    return buildScaffold({
      provenance: 'lightweight',
      analysis: light,
      options,
      full,
      raw,
    });
  }
  // Regex fallback.
  const v1 = inferTemplateBody(options) as IInferTemplateBodyResult;
  if (v1.scaffold) {
    const v2: IInferredTemplateScaffoldV2 = {
      ...v1.scaffold,
      provenance: 'regex',
      confidenceReasons: ['regex fallback — class/function detection via regex'],
      decorators: [],
      publicMethods: [],
    };
    return { scaffold: v2, provenance: 'regex' };
  }
  return {
    scaffold: null,
    reason: v1.reason ?? 'all inference strategies failed',
    provenance: 'skipped',
  };
}

interface IAnalysis {
  success: boolean;
  className?: string;
  functionName?: string;
  componentName?: string;
  defaultExportName?: string;
  decorators: string[];
  jsdoc?: string;
  publicMethods: string[];
  imports: string[];
  reasons: string[];
}

function analyzeWithTypescript(
  ts: typeof import('typescript'),
  src: string,
  filename: string,
): IAnalysis {
  const reasons: string[] = [];
  const sf = ts.createSourceFile(filename, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const result: IAnalysis = {
    success: true,
    decorators: [],
    publicMethods: [],
    imports: [],
    reasons,
  };
  const visit = (node: TsNode): void => {
    if (ts.isImportDeclaration(node)) {
      const ms = node.moduleSpecifier;
      if (ts.isStringLiteral(ms)) result.imports.push(ms.text);
    }
    if (ts.isClassDeclaration(node) && node.name && !result.className) {
      result.className = node.name.text;
      reasons.push(`detected class "${result.className}" via TS AST`);
      const decos = (
        (node as unknown as { decorators?: ReadonlyArray<TsDecorator> }).decorators ?? []
      );
      for (const d of decos) {
        result.decorators.push(d.expression.getText(sf));
      }
      const modifiers = ts.canHaveModifiers(node)
        ? ts.getModifiers(node) ?? []
        : [];
      void modifiers;
      // Public methods
      for (const m of node.members) {
        if (ts.isMethodDeclaration(m) && m.name && ts.isIdentifier(m.name)) {
          const mods = ts.canHaveModifiers(m) ? ts.getModifiers(m) ?? [] : [];
          const isPrivate = mods.some(
            (mod) =>
              mod.kind === ts.SyntaxKind.PrivateKeyword ||
              mod.kind === ts.SyntaxKind.ProtectedKeyword,
          );
          if (!isPrivate) result.publicMethods.push(m.name.text);
        }
      }
      // JSDoc
      const jsdocs = (node as unknown as { jsDoc?: Array<{ getText(): string }> }).jsDoc ?? [];
      if (jsdocs.length > 0) result.jsdoc = jsdocs[0]!.getText().slice(0, 240);
    }
    if (ts.isFunctionDeclaration(node) && node.name && !result.functionName) {
      result.functionName = node.name.text;
      reasons.push(`detected function "${result.functionName}" via TS AST`);
    }
    if (ts.isVariableStatement(node)) {
      const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : [];
      const isExport = mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (isExport) {
        for (const d of node.declarationList.declarations) {
          if (d.name && ts.isIdentifier(d.name)) {
            if (!result.functionName && d.initializer && ts.isArrowFunction(d.initializer)) {
              result.functionName = d.name.text;
              reasons.push(`detected arrow-function export "${d.name.text}" via TS AST`);
            }
            if (
              !result.componentName &&
              /^[A-Z]/.test(d.name.text) &&
              d.initializer &&
              (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))
            ) {
              result.componentName = d.name.text;
              reasons.push(`detected component "${d.name.text}" via TS AST`);
            }
          }
        }
      }
    }
    if (ts.isExportAssignment(node) && !result.defaultExportName) {
      if (ts.isIdentifier(node.expression)) {
        result.defaultExportName = node.expression.text;
        reasons.push(`detected default export "${node.expression.text}" via TS AST`);
      }
    }
    ts.forEachChild(node, visit);
  };
  try {
    visit(sf);
  } catch (e) {
    return {
      success: false,
      decorators: [],
      publicMethods: [],
      imports: [],
      reasons: [`AST visit threw: ${(e as Error).message}`],
    };
  }
  if (!result.className && !result.functionName && !result.componentName) {
    return { ...result, success: false, reasons: [...reasons, 'no top-level class/function/component'] };
  }
  return result;
}

function analyzeLightweight(src: string): IAnalysis {
  // Bracket-balance + identifier-token scan — no regex backtracking.
  const reasons: string[] = ['lightweight (no TS) — bracket/identifier scan'];
  const result: IAnalysis = {
    success: true,
    decorators: [],
    publicMethods: [],
    imports: [],
    reasons,
  };
  const tokens = src.split(/\b/);
  let prev = '';
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    const trim = t.trim();
    if (prev === 'class' && /^[A-Z][A-Za-z0-9_]*$/.test(trim) && !result.className) {
      result.className = trim;
      reasons.push(`detected class "${trim}" via lightweight scan`);
    }
    if (
      (prev === 'function' || prev === 'function*') &&
      /^[a-zA-Z_][A-Za-z0-9_]*$/.test(trim) &&
      !result.functionName
    ) {
      result.functionName = trim;
      reasons.push(`detected function "${trim}" via lightweight scan`);
    }
    if (/\S/.test(t)) prev = trim;
  }
  // Cheap component detection: `export const Foo = (`/`export function Foo(`
  const compM = src.match(/export\s+(?:default\s+)?(?:const|function)\s+([A-Z][A-Za-z0-9_]*)/);
  if (compM && !result.componentName) {
    result.componentName = compM[1]!;
    reasons.push(`detected component "${result.componentName}" via lightweight scan`);
  }
  // Imports: simple split on "from '...'".
  const importRe = /import[^;]*from\s+['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(src))) result.imports.push(m[1]!);
  if (!result.className && !result.functionName && !result.componentName) {
    return { ...result, success: false };
  }
  return result;
}

interface IBuildScaffoldInput {
  provenance: TemplateInferenceProvenance;
  analysis: IAnalysis;
  options: IInferTemplateBodyOptions;
  full: string;
  raw: string;
}

function buildScaffold(input: IBuildScaffoldInput): IInferTemplateBodyV2Result {
  const { options, analysis, raw } = input;
  const baseName = nodePath.basename(input.full);
  const constructForKind = constructTokenForKind(options.kind);
  const kebabName = extractKebabName(baseName, constructForKind);
  if (!kebabName) {
    return {
      scaffold: null,
      reason: `could not derive a base name from "${baseName}"`,
      provenance: 'skipped',
    };
  }

  const variables: { name: string; description: string; default?: string }[] = [
    { name: 'name', description: 'kebab-case base name', default: kebabName },
  ];
  let body = raw;
  let confidence: 'high' | 'medium' | 'low' = 'high';
  const reasons: string[] = [...analysis.reasons];

  if (analysis.className) {
    body = replaceWholeWord(body, analysis.className, '<className>');
    variables.push({
      name: 'className',
      description: 'PascalCase class identifier',
      default: analysis.className,
    });
  }
  if (analysis.functionName && !analysis.className) {
    body = replaceWholeWord(body, analysis.functionName, '<fnName>');
    variables.push({
      name: 'fnName',
      description: 'camelCase function identifier',
      default: analysis.functionName,
    });
  }
  if (analysis.componentName && !analysis.className) {
    body = replaceWholeWord(body, analysis.componentName, '<componentName>');
    variables.push({
      name: 'componentName',
      description: 'PascalCase component identifier',
      default: analysis.componentName,
    });
    if (options.kind === 'test') {
      variables.push({
        name: 'testName',
        description: 'PascalCase suite/test identifier',
        default: analysis.componentName,
      });
    }
  }
  body = replaceWholeWord(body, kebabName, '<name>');

  const warnings: string[] = [];
  if (!analysis.className && options.kind === 'service') {
    confidence = 'medium';
    warnings.push('No class declaration found — service shape is a best guess.');
  }
  if (!analysis.functionName && options.kind === 'utility') {
    confidence = 'medium';
    warnings.push('No top-level function found — utility shape is a best guess.');
  }
  if (analysis.imports.some((i) => i.startsWith('.') || i.startsWith('/'))) {
    warnings.push('Sample has relative/aliased imports — preserved as TODOs.');
    confidence = confidence === 'high' ? 'medium' : confidence;
  }
  if (input.provenance === 'lightweight' && confidence === 'high') {
    confidence = 'medium';
    reasons.push('lightweight scan reduces confidence by one notch');
  }
  if (input.provenance === 'regex' && confidence === 'high') {
    confidence = 'medium';
    reasons.push('regex fallback reduces confidence by one notch');
  }

  const baseId = options.baseId ?? `inferred.typescript.${options.kind}`;
  const targetPath = suggestedTargetPath(options.kind, constructForKind);
  const name = displayNameForKind(options.kind);
  const description = descriptionForKind(options.kind);

  const scaffold: IInferredTemplateScaffoldV2 = {
    id: baseId,
    name,
    description,
    variables,
    targetPath,
    content: body,
    confidence,
    sample: nodePath.relative(options.projectRoot, input.full),
    warnings,
    provenance: input.provenance,
    confidenceReasons: reasons,
    decorators: analysis.decorators,
    publicMethods: analysis.publicMethods,
    ...(analysis.jsdoc ? { jsdoc: analysis.jsdoc } : {}),
  };
  return { scaffold, provenance: input.provenance };
}

// ── Helpers (shared with v1) ────────────────────────────────────────────────

function constructTokenForKind(kind: IInferTemplateBodyOptions['kind']): string {
  switch (kind) {
    case 'service':
      return 'service';
    case 'utility':
      return 'util';
    case 'test':
      return 'spec';
    case 'component':
      return 'component';
  }
}

function suggestedTargetPath(
  kind: IInferTemplateBodyOptions['kind'],
  construct: string,
): string {
  switch (kind) {
    case 'service':
      return `src/services/<name>.${construct}.ts`;
    case 'utility':
      return `src/utils/<name>.${construct}.ts`;
    case 'test':
      return `tests/<name>.${construct}.ts`;
    case 'component':
      return `src/components/<componentName>/<componentName>.${construct}.tsx`;
  }
}

function displayNameForKind(kind: IInferTemplateBodyOptions['kind']): string {
  switch (kind) {
    case 'service':
      return 'TypeScript service';
    case 'utility':
      return 'TypeScript utility';
    case 'test':
      return 'TypeScript spec';
    case 'component':
      return 'TypeScript component';
  }
}

function descriptionForKind(kind: IInferTemplateBodyOptions['kind']): string {
  switch (kind) {
    case 'service':
      return 'Generate a new service modeled on the most representative sample in src/services/.';
    case 'utility':
      return 'Generate a new utility module modeled on src/utils/.';
    case 'test':
      return 'Generate a new spec/test file modeled on the project test layout.';
    case 'component':
      return 'Generate a new UI component modeled on existing components.';
  }
}

function extractKebabName(filename: string, construct: string): string | null {
  const noExt = filename.replace(/\.(tsx?|jsx?)$/i, '');
  let base = noExt;
  if (construct === 'spec') base = base.replace(/\.(spec|test)$/i, '');
  else base = base.replace(new RegExp(`\\.${construct}$`, 'i'), '');
  if (!base || base === noExt) return null;
  const kebab = base
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_+/g, '-')
    .toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(kebab)) return null;
  return kebab;
}

function countDomainLiterals(src: string): number {
  let count = 0;
  const re = /(['"`])(?:\\.|(?!\1).){3,}\1/g;
  while (re.exec(src)) count += 1;
  return count;
}

function hasSideEffectfulTopLevel(src: string): boolean {
  // Detect top-level (depth==0) statements that aren't declarations/imports.
  // We track brace depth so we don't flag class members or function bodies.
  const lines = src.split(/\r?\n/);
  let depth = 0;
  for (const l of lines) {
    const t = l.trimStart();
    if (!t) {
      depth = updateDepth(depth, l);
      continue;
    }
    const isComment = t.startsWith('//') || t.startsWith('/*');
    if (!isComment && depth === 0) {
      if (!/^(import|export|interface|class|function|type|const|let|var|enum|declare|namespace|abstract)\b/.test(t)
        && !/^@/.test(t)
        && /^[A-Za-z_$][\w$]*\s*\(/.test(t)
        && !t.startsWith('describe(')
        && !t.startsWith('test(')
        && !t.startsWith('it(')
      ) {
        return true;
      }
      if (/^\(/.test(t)) return true; // IIFE
    }
    depth = updateDepth(depth, l);
  }
  return false;
}

function updateDepth(depth: number, line: string): number {
  // Strip strings and comments before counting braces. Cheap pass.
  let stripped = line;
  stripped = stripped.replace(/\/\/.*$/, '');
  stripped = stripped.replace(/'(?:\\.|[^'\\])*'/g, "''");
  stripped = stripped.replace(/"(?:\\.|[^"\\])*"/g, '""');
  stripped = stripped.replace(/`(?:\\.|[^`\\])*`/g, '``');
  for (const c of stripped) {
    if (c === '{') depth += 1;
    else if (c === '}') depth = Math.max(0, depth - 1);
  }
  return depth;
}

function replaceWholeWord(src: string, needle: string, replacement: string): string {
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b${esc}\\b`, 'g');
  return src.replace(re, replacement);
}
