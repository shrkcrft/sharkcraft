import { existsSync, readFileSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';

/**
 * Variable produced by template-body inference. Mirrors the shape used by
 * `@shrkcrft/templates` (`ITemplateVariable`) but is decoupled here so the
 * inspector layer does not depend on the templates layer for shape.
 */
export interface IInferredTemplateVariable {
  name: string;
  description: string;
  /** A best-effort default we observed from the sample (file kebab name). */
  default?: string;
}

export interface IInferredTemplateScaffold {
  /** Suggested template id (e.g. `inferred.typescript.service`). */
  id: string;
  /** Human-friendly display name. */
  name: string;
  /** Short description for the draft. */
  description: string;
  /** Inferred variables (each maps to a `<placeholder>` in `content`). */
  variables: readonly IInferredTemplateVariable[];
  /** Suggested `targetPath` pattern, e.g. `src/services/<name>.service.ts`. */
  targetPath: string;
  /** Suggested template body with `<placeholder>` tokens replacing identifiers. */
  content: string;
  /** Confidence level. */
  confidence: 'high' | 'medium' | 'low';
  /** Sample file inspected (project-relative). */
  sample: string;
  /** Warnings the user should review before adopting. */
  warnings: readonly string[];
}

export interface IInferTemplateBodyOptions {
  /** Absolute path to the project root (sample is resolved relative to it). */
  projectRoot: string;
  /** Project-relative sample file path. */
  sample: string;
  /** Template kind hint (chooses naming defaults). */
  kind: 'service' | 'utility' | 'test' | 'component';
  /** Base id for the produced template (default derived from kind). */
  baseId?: string;
  /** Soft cap on file size — larger files are skipped. */
  maxBytes?: number;
  /** Soft cap on line count — larger files are skipped. */
  maxLines?: number;
}

export interface IInferTemplateBodyResult {
  scaffold: IInferredTemplateScaffold | null;
  /** Why we couldn't scaffold (only set when scaffold is null). */
  reason?: string;
}

const DEFAULT_MAX_BYTES = 20_000;
const DEFAULT_MAX_LINES = 200;
/** Maximum count of single-letter / domain-y string literals before we bail. */
const MAX_DOMAIN_LITERALS = 12;

/**
 * Read a sample file and produce a minimal, runnable draft template body by
 * replacing concrete identifiers with `<name>` / `<className>` placeholders.
 *
 * Never throws — returns `{ scaffold: null, reason }` on any structural reason
 * to skip. Callers should fall back to the non-scaffolded candidate.
 */
export function inferTemplateBody(
  options: IInferTemplateBodyOptions,
): IInferTemplateBodyResult {
  const full = nodePath.isAbsolute(options.sample)
    ? options.sample
    : nodePath.join(options.projectRoot, options.sample);
  if (!existsSync(full)) {
    return { scaffold: null, reason: `sample not found: ${options.sample}` };
  }
  const stat = statSync(full);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  if (stat.size > maxBytes) {
    return {
      scaffold: null,
      reason: `sample too large (${stat.size} > ${maxBytes} bytes)`,
    };
  }
  const raw = readFileSync(full, 'utf8');
  const lineCount = raw.split(/\r?\n/).length;
  if (lineCount > maxLines) {
    return {
      scaffold: null,
      reason: `sample too long (${lineCount} > ${maxLines} lines)`,
    };
  }

  // ── Identify the construct token from filename. ────────────────────────
  // file basename → "user.service.ts" → kebab name "user", construct "service".
  const baseName = nodePath.basename(full);
  const constructForKind = constructTokenForKind(options.kind);
  const kebabName = extractKebabName(baseName, constructForKind);
  if (!kebabName) {
    return {
      scaffold: null,
      reason: `could not derive a base name from "${baseName}"`,
    };
  }

  // ── Detect dominant class / function identifier. ────────────────────────
  const classMatch = findFirstClass(raw);
  const fnMatch = findFirstFunction(raw);
  const componentMatch = findFirstComponent(raw);

  const warnings: string[] = [];

  // ── Domain-literal complexity guard. ────────────────────────────────────
  const literals = countStringLiterals(raw);
  if (literals > MAX_DOMAIN_LITERALS) {
    return {
      scaffold: null,
      reason: `sample contains ${literals} string literals — too domain-specific to scaffold`,
    };
  }

  // ── Complex-imports guard. ──────────────────────────────────────────────
  const imports = extractImports(raw);
  const safeImports = imports.every(isSafeImport);
  if (!safeImports) {
    warnings.push(
      'Sample imports complex paths (relative or local aliases) — scaffold preserves them as TODOs.',
    );
  }
  if (imports.length > 6) {
    warnings.push(
      `Sample has ${imports.length} imports; scaffold keeps them with TODO placeholders.`,
    );
  }

  // ── Build placeholder-substituted body. ────────────────────────────────
  let body = raw;
  const variables: IInferredTemplateVariable[] = [
    {
      name: 'name',
      description: 'kebab-case base name (e.g. user, order, billing)',
      default: kebabName,
    },
  ];

  // Replace class name with <ClassName> placeholder if it exists.
  if (classMatch) {
    const ph = '<className>';
    body = replaceWholeWord(body, classMatch.name, ph);
    variables.push({
      name: 'className',
      description: 'PascalCase class identifier',
      default: classMatch.name,
    });
  }

  // For utilities: replace top-level function name with <fnName>.
  if (options.kind === 'utility' && fnMatch && !classMatch) {
    const ph = '<fnName>';
    body = replaceWholeWord(body, fnMatch.name, ph);
    variables.push({
      name: 'fnName',
      description: 'camelCase function identifier',
      default: fnMatch.name,
    });
  }

  // For components: replace component name with <ComponentName>.
  if (options.kind === 'component' && componentMatch && !classMatch) {
    const ph = '<componentName>';
    body = replaceWholeWord(body, componentMatch.name, ph);
    variables.push({
      name: 'componentName',
      description: 'PascalCase component identifier',
      default: componentMatch.name,
    });
  }

  // Replace kebab base name everywhere it appears as a whole token.
  // Skip the construct token portion (e.g. "service") to avoid clobbering.
  body = replaceWholeWord(body, kebabName, '<name>');

  // ── Confidence ─────────────────────────────────────────────────────────
  let confidence: 'high' | 'medium' | 'low' = 'high';
  if (!classMatch && options.kind === 'service') {
    confidence = 'medium';
    warnings.push('No class declaration found in sample — service shape is a best guess.');
  }
  if (!fnMatch && options.kind === 'utility') {
    confidence = 'medium';
    warnings.push('No top-level function found in sample — utility shape is a best guess.');
  }
  if (!safeImports || imports.length > 6) {
    confidence = confidence === 'high' ? 'medium' : confidence;
  }

  // ── Final scaffold ─────────────────────────────────────────────────────
  const baseId = options.baseId ?? `inferred.typescript.${options.kind}`;
  const targetPath = suggestedTargetPath(options.kind, constructForKind);
  const name = displayNameForKind(options.kind);
  const description = descriptionForKind(options.kind);

  return {
    scaffold: {
      id: baseId,
      name,
      description,
      variables,
      targetPath,
      content: body,
      confidence,
      sample: nodePath.relative(options.projectRoot, full),
      warnings,
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────

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
  // Strip extension and the construct suffix.
  // Accepts forms like:
  //   user.service.ts → user
  //   format-email.util.ts → format-email
  //   user.spec.ts / user.test.ts → user
  //   Greeting.component.tsx → greeting
  const noExt = filename.replace(/\.(tsx?|jsx?)$/i, '');
  let base = noExt;
  if (construct === 'spec') {
    base = base.replace(/\.(spec|test)$/i, '');
  } else {
    const re = new RegExp(`\\.${construct}$`, 'i');
    base = base.replace(re, '');
  }
  if (!base || base === noExt) return null;
  // Normalize to kebab-case for the default value.
  const kebab = base
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_+/g, '-')
    .toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(kebab)) return null;
  return kebab;
}

interface IIdentifierMatch {
  name: string;
}

function findFirstClass(src: string): IIdentifierMatch | null {
  const m = /\bclass\s+([A-Z][A-Za-z0-9_]*)/m.exec(src);
  return m ? { name: m[1]! } : null;
}

function findFirstFunction(src: string): IIdentifierMatch | null {
  // Try `export function name`, `export const name = (`, `function name`.
  const exportFn = /\bexport\s+function\s+([a-zA-Z_][A-Za-z0-9_]*)/m.exec(src);
  if (exportFn) return { name: exportFn[1]! };
  const exportConst = /\bexport\s+const\s+([a-zA-Z_][A-Za-z0-9_]*)\s*=\s*(?:async\s*)?\(/m.exec(src);
  if (exportConst) return { name: exportConst[1]! };
  const plainFn = /\bfunction\s+([a-zA-Z_][A-Za-z0-9_]*)/m.exec(src);
  if (plainFn) return { name: plainFn[1]! };
  return null;
}

function findFirstComponent(src: string): IIdentifierMatch | null {
  // `export const Foo: FC = ` / `export function Foo(` / `export default function Foo`.
  const m =
    /\bexport\s+(?:default\s+)?(?:function|const)\s+([A-Z][A-Za-z0-9_]*)/m.exec(src);
  return m ? { name: m[1]! } : null;
}

function countStringLiterals(src: string): number {
  let count = 0;
  // Naive but bounded: count single/double/backtick strings of length > 2.
  const re = /(['"`])(?:\\.|(?!\1).){3,}\1/g;
  while (re.exec(src)) count += 1;
  if (count > MAX_DOMAIN_LITERALS) return count;
  return count;
}

function extractImports(src: string): string[] {
  const out: string[] = [];
  const re = /\bimport\s+(?:.|\n)*?from\s+['"]([^'"]+)['"]\s*;?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.push(m[1]!);
  return out;
}

function isSafeImport(spec: string): boolean {
  // Node built-ins, framework packages, and bare specifiers are safe.
  // Relative imports / aliased imports require user attention.
  if (spec.startsWith('.') || spec.startsWith('/')) return false;
  if (spec.startsWith('@') && spec.includes('/')) return true;
  if (/^[a-z][a-z0-9-]*(?:\/[^?]+)?$/i.test(spec)) return true;
  return false;
}

function replaceWholeWord(src: string, needle: string, replacement: string): string {
  // Escape regex specials in `needle`, then replace whole-token matches.
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b${esc}\\b`, 'g');
  return src.replace(re, replacement);
}
