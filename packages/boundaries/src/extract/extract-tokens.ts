import {
  resolveExtractorAnchor,
  resolveExtractorKind,
  validateWiringSource,
  type ExtractorKind,
  type IWiringSource,
} from '@shrkcrft/core';
import { safeCompile } from '../util/safe-regex.ts';
import { extractImportEdges } from './import-edges.ts';
import type { ITsconfigPathsMap } from '../scan/tsconfig-aliases.ts';
import {
  elementToken,
  elementValue,
  escapeRegex,
  lineOf,
  scanBalanced,
} from './scan-literals.ts';

/** A file made available to an extractor. */
export interface IExtractFileEntry {
  /** Project-relative POSIX path. */
  readonly path: string;
  readonly content: string;
}

/** A captured id + where it was captured. */
export interface IExtractedSite {
  readonly token: string;
  readonly file: string;
  readonly line: number;
}

/**
 * Optional project context an extractor may need.
 *
 * Kept OUT of the source spec because it is not part of the rule — it is what
 * the caller knows about the workspace. Only `import-edges` reads it today, and
 * every other kind stays a pure function of (source, file contents).
 */
export interface IExtractContext {
  /** tsconfig `paths` map, so alias specifiers resolve as the compiler would. */
  readonly tsconfigPaths?: ITsconfigPathsMap;
}

/** Outcome of running one source: the sites, or a configuration error. */
export interface IExtractResult {
  readonly sites: readonly IExtractedSite[];
  /** Set when the SOURCE is misconfigured (never thrown — rules degrade). */
  readonly error?: string;
  /**
   * A diagnosis for a zero-match that is CORRECT but almost certainly not what
   * the author meant. Distinct from `error`: nothing is wrong with the source,
   * it just cannot mean what it looks like it means.
   */
  readonly hint?: string;
}

/**
 * Run one source's extractor over the given files.
 *
 * This is the reusable core of the completeness plane: wiring rules, registry
 * inventories, and extractor-backed baselines all harvest their ids through
 * here, so every one of them honours the exact same semantics (and gains every
 * new extractor kind for free). Never throws — a misconfigured source returns
 * an `error` and no sites.
 */
export function extractTokens(
  source: IWiringSource,
  files: readonly IExtractFileEntry[],
  context: IExtractContext = {},
): IExtractResult {
  const error = validateWiringSource(source);
  if (error) return { sites: [], error };

  const kind = resolveExtractorKind(source)!;
  const anchor = resolveExtractorAnchor(source);
  let sites: IExtractedSite[];
  switch (kind) {
    case 'regex-capture':
      sites = byRegex(source, files);
      break;
    case 'array-members':
      sites = byBracketLiteral(anchor!, '[', files, (el) => elementToken(el));
      break;
    case 'object-keys':
      sites = byBracketLiteral(anchor!, '{', files, (el) =>
        source.capture === 'value' ? elementValue(el) : elementToken(el),
      );
      break;
    case 'enum-members':
      sites = byEnumMembers(anchor!, source.capture === 'value', files);
      break;
    case 'export-names':
      sites = byExportNames(files);
      break;
    case 'call-args':
      sites = byCallArgs(anchor!, source.argIndex ?? 0, false, files);
      break;
    case 'decorator-args':
      sites = byCallArgs(anchor!, source.argIndex ?? 0, true, files);
      break;
    case 'string-union-members':
      sites = byStringUnion(anchor!, files);
      break;
    case 'json-path':
      sites = byJsonPath(source.jsonPath!, files);
      break;
    case 'filenames':
      sites = byFilenames(source, files);
      break;
    case 'import-edges': {
      const edges = extractImportEdges(source, files, {
        ...(context.tsconfigPaths ? { tsconfigPaths: context.tsconfigPaths } : {}),
      });
      if (edges.error) return { sites: [], error: edges.error };
      if (edges.hint) return { sites: edges.sites, hint: edges.hint };
      sites = edges.sites;
      break;
    }
    default:
      return { sites: [], error: `unknown extract kind "${String(kind)}"` };
  }

  if (source.match !== undefined) {
    const { re } = safeCompile(source.match, source.matchFlags);
    if (re) {
      sites = sites.filter((s) => {
        re.lastIndex = 0;
        return re.test(s.token);
      });
    }
  }
  if (source.exclude !== undefined) {
    const { re } = safeCompile(source.exclude, source.excludeFlags);
    if (re) {
      sites = sites.filter((s) => {
        re.lastIndex = 0;
        return !re.test(s.token);
      });
    }
  }
  return { sites };
}


/**
 * One id per FILE, derived from its path.
 *
 * Every other extractor reads a file's CONTENTS, so "a declared thing must have
 * its sibling FILE" — a `FOO_DESCRIPTOR` const paired with `FOO_DESCRIPTOR.ts` —
 * had no expression at all. Paired with a `parity` wiring rule this asserts the
 * correspondence in BOTH directions: a const with no file, and a file with no
 * const.
 *
 * The site line is 1: the id comes from the path, not from any line in it, and
 * claiming a more specific location would be inventing one.
 */
function byFilenames(
  source: IWiringSource,
  files: readonly IExtractFileEntry[],
): IExtractedSite[] {
  const capture = source.capturePath ?? 'stem';
  let re: RegExp | undefined;
  if (capture === 'regex') {
    const compiled = safeCompile(source.pathPattern!, source.pathPatternFlags);
    if (!compiled.re) return [];
    re = compiled.re;
  }
  const sites: IExtractedSite[] = [];
  for (const file of files) {
    if (capture === 'regex') {
      re!.lastIndex = 0;
      const m = re!.exec(file.path);
      if (m?.[1]) sites.push({ token: m[1], file: file.path, line: 1 });
      continue;
    }
    const basename = file.path.slice(file.path.lastIndexOf('/') + 1);
    const dot = basename.indexOf('.');
    const token = capture === 'basename' || dot <= 0 ? basename : basename.slice(0, dot);
    sites.push({ token, file: file.path, line: 1 });
  }
  return sites;
}

/** Capture-group-1 of a pattern, per file. */
function byRegex(source: IWiringSource, files: readonly IExtractFileEntry[]): IExtractedSite[] {
  const { re } = safeCompile(source.pattern!, source.flags);
  if (!re) return [];
  const sites: IExtractedSite[] = [];
  for (const f of files) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(f.content)) !== null) {
      // Guard against a zero-width match looping forever.
      if (m.index === re.lastIndex) re.lastIndex += 1;
      const token = m[1];
      if (token === undefined || token === '') continue;
      sites.push({ token, file: f.path, line: lineOf(f.content, m.index) });
    }
  }
  return sites;
}

/**
 * Elements of every `<anchor> = <open> … ` / `<anchor>: <open> … ` literal.
 *
 * Covers `export const ARR = [ … ]`, an inline `arrayProperty: [ … ]`, a typed
 * `const ARR: readonly T[] = [ … ]`, and the very common freeze/wrapper form
 * `export const ARR = Object.freeze([ … ])` — a registry array is nearly always
 * wrapped, and missing that would silently extract nothing.
 */
function byBracketLiteral(
  anchor: string,
  open: '[' | '{',
  files: readonly IExtractFileEntry[],
  tokenOf: (elementText: string) => string | undefined,
): IExtractedSite[] {
  const sites: IExtractedSite[] = [];
  const head = new RegExp(
    `(?<![\\w$])${escapeRegex(anchor)}\\s*(?::[^=\\n]*)?[:=]\\s*(?:[A-Za-z_$][\\w$.]*\\s*\\(\\s*)?\\${open}`,
    'g',
  );
  for (const f of files) {
    head.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = head.exec(f.content)) !== null) {
      if (m.index === head.lastIndex) head.lastIndex += 1;
      const openIndex = m.index + m[0].length - 1;
      const { elements, end } = scanBalanced(f.content, openIndex);
      for (const el of elements) {
        const token = tokenOf(el.text);
        if (token === undefined || token === '') continue;
        sites.push({ token, file: f.path, line: lineOf(f.content, el.index) });
      }
      head.lastIndex = Math.max(end + 1, head.lastIndex);
    }
  }
  return sites;
}

/** Members of `enum <anchor> { … }` — the member name, or its assigned value. */
function byEnumMembers(
  anchor: string,
  wantValue: boolean,
  files: readonly IExtractFileEntry[],
): IExtractedSite[] {
  const sites: IExtractedSite[] = [];
  const head = new RegExp(`\\benum\\s+${escapeRegex(anchor)}\\s*\\{`, 'g');
  for (const f of files) {
    head.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = head.exec(f.content)) !== null) {
      if (m.index === head.lastIndex) head.lastIndex += 1;
      const openIndex = m.index + m[0].length - 1;
      const { elements, end } = scanBalanced(f.content, openIndex);
      for (const el of elements) {
        const token = wantValue ? elementValue(el.text) : elementToken(el.text);
        if (token === undefined || token === '') continue;
        sites.push({ token, file: f.path, line: lineOf(f.content, el.index) });
      }
      head.lastIndex = Math.max(end + 1, head.lastIndex);
    }
  }
  return sites;
}

/** Every exported binding name, including re-export aliases (`export { A as B }` → `B`). */
const EXPORT_DECL =
  /\bexport\s+(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/g;
const EXPORT_CLAUSE = /\bexport\s*(?:type\s+)?\{([^}]*)\}/g;

function byExportNames(files: readonly IExtractFileEntry[]): IExtractedSite[] {
  const sites: IExtractedSite[] = [];
  for (const f of files) {
    EXPORT_DECL.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = EXPORT_DECL.exec(f.content)) !== null) {
      sites.push({ token: m[1]!, file: f.path, line: lineOf(f.content, m.index) });
    }
    EXPORT_CLAUSE.lastIndex = 0;
    while ((m = EXPORT_CLAUSE.exec(f.content)) !== null) {
      const line = lineOf(f.content, m.index);
      for (const raw of m[1]!.split(',')) {
        const spec = raw.trim().replace(/^type\s+/, '');
        if (spec === '' || spec === 'default') continue;
        // `A as B` exports B; a bare `A` exports A.
        const parts = spec.split(/\s+as\s+/);
        const name = (parts[parts.length - 1] ?? '').trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) sites.push({ token: name, file: f.path, line });
      }
    }
  }
  return sites;
}

/** Argument `argIndex` of every `anchor(…)` call — or `@anchor(…)` decorator. */
function byCallArgs(
  anchor: string,
  argIndex: number,
  decorator: boolean,
  files: readonly IExtractFileEntry[],
): IExtractedSite[] {
  const sites: IExtractedSite[] = [];
  const head = decorator
    ? new RegExp(`@${escapeRegex(anchor)}\\s*\\(`, 'g')
    : new RegExp(`(?<![\\w$.@])${escapeRegex(anchor)}\\s*\\(`, 'g');
  for (const f of files) {
    head.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = head.exec(f.content)) !== null) {
      if (m.index === head.lastIndex) head.lastIndex += 1;
      const openIndex = m.index + m[0].length - 1;
      const { elements, end } = scanBalanced(f.content, openIndex);
      const el = elements[argIndex];
      if (el) {
        const token = elementToken(el.text);
        if (token !== undefined && token !== '') {
          sites.push({ token, file: f.path, line: lineOf(f.content, el.index) });
        }
      }
      head.lastIndex = Math.max(end + 1, head.lastIndex);
    }
  }
  return sites;
}

/** The string literals of `type <anchor> = 'a' | 'b' | 'c'`. */
function byStringUnion(anchor: string, files: readonly IExtractFileEntry[]): IExtractedSite[] {
  const sites: IExtractedSite[] = [];
  const head = new RegExp(`\\btype\\s+${escapeRegex(anchor)}\\s*(?:<[^>]*>)?\\s*=`, 'g');
  const member = /['"`]([^'"`]+)['"`]/g;
  for (const f of files) {
    head.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = head.exec(f.content)) !== null) {
      if (m.index === head.lastIndex) head.lastIndex += 1;
      const start = m.index + m[0].length;
      // The alias body runs to the first `;` or blank line at depth 0.
      const semi = f.content.indexOf(';', start);
      const blank = f.content.indexOf('\n\n', start);
      const ends = [semi, blank].filter((i) => i >= 0);
      const end = ends.length > 0 ? Math.min(...ends) : f.content.length;
      const body = f.content.slice(start, end);
      member.lastIndex = 0;
      let mm: RegExpExecArray | null;
      while ((mm = member.exec(body)) !== null) {
        sites.push({
          token: mm[1]!,
          file: f.path,
          line: lineOf(f.content, start + mm.index),
        });
      }
      head.lastIndex = Math.max(end, head.lastIndex);
    }
  }
  return sites;
}

/**
 * Leaves selected by a JSON path. Supports `.key`, `[n]`, `[*]`; a leading `$.`
 * is accepted and ignored. Scalars become ids; a selected object contributes
 * its KEYS (so `compilerOptions.paths` yields the alias names). Line numbers are
 * resolved by locating the token's first quoted occurrence in the raw text —
 * exact when the id is unique, and honestly approximate when it is not.
 */
function byJsonPath(jsonPath: string, files: readonly IExtractFileEntry[]): IExtractedSite[] {
  const segments = parseJsonPath(jsonPath);
  const sites: IExtractedSite[] = [];
  for (const f of files) {
    let doc: unknown;
    try {
      doc = JSON.parse(f.content);
    } catch {
      continue; // not JSON — a `json-path` source over mixed globs skips it
    }
    for (const leaf of selectJsonPath(doc, segments)) {
      const token = String(leaf);
      if (token === '') continue;
      const at = f.content.indexOf(`"${token}"`);
      sites.push({
        token,
        file: f.path,
        line: at >= 0 ? lineOf(f.content, at) : 1,
      });
    }
  }
  return sites;
}

/** One step of a parsed JSON path: a literal key, an index, or the `*` wildcard. */
type JsonPathSegment = { readonly key: string } | { readonly index: number } | { readonly all: true };

function parseJsonPath(path: string): readonly JsonPathSegment[] {
  const out: JsonPathSegment[] = [];
  const cleaned = path.replace(/^\$\.?/, '');
  for (const part of cleaned.split('.')) {
    if (part === '') continue;
    const head = part.replace(/\[.*$/, '');
    if (head !== '') out.push({ key: head });
    for (const b of part.matchAll(/\[([^\]]*)\]/g)) {
      const inner = (b[1] ?? '').trim();
      if (inner === '*') out.push({ all: true });
      else if (/^\d+$/.test(inner)) out.push({ index: Number(inner) });
      else out.push({ key: inner.replace(/^['"]|['"]$/g, '') });
    }
  }
  return out;
}

function selectJsonPath(doc: unknown, segments: readonly JsonPathSegment[]): string[] {
  let current: unknown[] = [doc];
  for (const seg of segments) {
    const next: unknown[] = [];
    for (const node of current) {
      if (node === null || node === undefined) continue;
      if ('all' in seg) {
        if (Array.isArray(node)) next.push(...node);
        else if (typeof node === 'object') next.push(...Object.values(node as object));
      } else if ('index' in seg) {
        if (Array.isArray(node)) next.push(node[seg.index]);
      } else if (typeof node === 'object' && !Array.isArray(node)) {
        next.push((node as Record<string, unknown>)[seg.key]);
      }
    }
    current = next;
  }
  const out: string[] = [];
  for (const leaf of current) {
    if (leaf === null || leaf === undefined) continue;
    if (typeof leaf === 'object') {
      // A selected object contributes its keys; an array, its scalar elements.
      if (Array.isArray(leaf)) {
        for (const el of leaf) if (typeof el === 'string' || typeof el === 'number') out.push(String(el));
      } else {
        out.push(...Object.keys(leaf as object));
      }
      continue;
    }
    if (typeof leaf === 'boolean') continue;
    out.push(String(leaf));
  }
  return out;
}
