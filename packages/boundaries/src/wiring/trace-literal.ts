import { readMatchingFiles, SKIP_DIRS } from '../util/walk-files.ts';

export const TRACE_SCHEMA = 'sharkcraft.trace/v1' as const;

/** Default source globs scanned when `trace` is given no `--glob`. */
export const TRACE_DEFAULT_GLOBS: readonly string[] = [
  '**/*.ts',
  '**/*.tsx',
  '**/*.mts',
  '**/*.cts',
  '**/*.js',
  '**/*.jsx',
  '**/*.mjs',
  '**/*.cjs',
];

/**
 * How a literal occurrence relates to the cross-fence contract — the direction
 * grep can't give you:
 *  - `declare`  — a canonical definition (`const X = 'lit'`, `kind: 'lit'`, an enum value).
 *  - `register` — added to a collection / mapping (`register('lit')`, an array element, `{ 'lit': … }`).
 *  - `consume`  — compared / switched / handled (`=== 'lit'`, `case 'lit':`).
 *  - `reference`— an occurrence we can't confidently classify (still reported, with context).
 */
export enum TraceRole {
  Declare = 'declare',
  Register = 'register',
  Consume = 'consume',
  Reference = 'reference',
}

/** One occurrence of the traced literal (or a const aliased to it). */
export interface ITraceSite {
  readonly file: string;
  readonly line: number;
  readonly role: TraceRole;
  /** The trimmed source line, for context. */
  readonly text: string;
  /** Set when this site reached the literal through a `const NAME = 'literal'` alias. */
  readonly viaAlias?: string;
}

export interface ITraceReport {
  readonly schema: typeof TRACE_SCHEMA;
  readonly literal: string;
  readonly total: number;
  /** Distinct files the literal (or an alias) was found in. */
  readonly files: number;
  /** Sites grouped by role, each group sorted by (file, line). */
  readonly byRole: Readonly<Record<TraceRole, readonly ITraceSite[]>>;
  /** Const names found bound to the literal (`const NAME = 'literal'`), if any. */
  readonly aliases: readonly string[];
}

export interface ITraceOptions {
  /** Override the default source globs. */
  readonly globs?: readonly string[];
  /** Project-relative directories to prune from the walk. */
  readonly excludeDirs?: readonly string[];
  /**
   * Resolve `const NAME = 'literal'` bindings and also classify uses of NAME
   * (flagged `viaAlias`). On by default — it is the cross-fence value over grep.
   */
  readonly resolveAliases?: boolean;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function lineStarts(content: string): number[] {
  const starts = [0];
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

/** 1-based line for a character offset, given precomputed line-start offsets. */
function lineAt(starts: readonly number[], offset: number): number {
  // Binary search for the greatest start <= offset.
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function lineText(content: string, starts: readonly number[], line: number): string {
  const start = starts[line - 1] ?? 0;
  const nl = content.indexOf('\n', start);
  return content.slice(start, nl === -1 ? content.length : nl);
}

/**
 * Heuristic declare-vs-register-vs-consume classifier from the text immediately
 * around the occurrence. High-precision rules first; anything unmatched stays
 * `reference` (reported, never silently dropped). Deterministic.
 */
function classifyRole(before: string, after: string): TraceRole {
  const b = before.replace(/\s+$/, '');
  const a = after.replace(/^\s+/, '');

  // switch/case handler.
  if (/\bcase$/.test(b) && a.startsWith(':')) return TraceRole.Consume;
  // equality / inequality comparison on either side.
  if (/(===|!==|==|!=)$/.test(b) || /^(===|!==|==|!=)/.test(a)) return TraceRole.Consume;
  // object / map key mapping: `{ 'lit': … }` or `, 'lit': …`.
  if (a.startsWith(':') && /[{,]$/.test(b)) return TraceRole.Register;
  // registration-ish call: register('lit'), provide('lit'), on('lit'), .set('lit', …).
  if (/\b(register|provide|add|use|on|handle|bind|emit|dispatch|listen|subscribe|define)\w*\($/i.test(b)) {
    return TraceRole.Register;
  }
  if (/\.\s*set\($/.test(b)) return TraceRole.Register;
  // array element: the literal directly follows `[` or `,`.
  if (/[[,]$/.test(b)) return TraceRole.Register;
  // canonical binding: const/let/var X = 'lit'.
  if (/\b(?:const|let|var)\s+[\w$]+\s*=$/.test(b)) return TraceRole.Declare;
  // definition-ish object property: `kind: 'lit'`, `id = 'lit'`, etc.
  if (/\b(kind|type|id|name|slug|key|tag|code|token|permission|route|event|action|channel|topic|status|provide|providerToken)\s*[:=]$/i.test(b)) {
    return TraceRole.Declare;
  }
  return TraceRole.Reference;
}

/** A const name is alias-resolvable only if Pascal/SCREAMING-cased (low collision risk). */
const ALIAS_NAME = /^[A-Z][\w$]*$/;

/**
 * Trace every declare → register → consume site of an EXACT string literal
 * across the tree, classifying each occurrence with a direction. Generalizes
 * `registry where` to any cross-fence string contract (a kind slug, permission
 * id, route key, data key) WITHOUT a pre-declared registry — point it at any
 * literal and get the chain grep can't: direction + role + layer-spanning
 * grouping, plus (by default) the const-alias bindings of the literal and their
 * use-sites. Pure-engine; the only IO is one read-only tree walk. Never throws.
 */
export function traceLiteral(
  projectRoot: string,
  literal: string,
  options: ITraceOptions = {},
): ITraceReport {
  const globs = options.globs && options.globs.length > 0 ? options.globs : TRACE_DEFAULT_GLOBS;
  const exclude = new Set(options.excludeDirs ?? []);
  const cache = readMatchingFiles(projectRoot, globs, exclude);

  const sites: ITraceSite[] = [];
  const aliasNames = new Set<string>();
  // Exact quoted-literal match: the closing quote immediately follows, so the
  // quoted CONTENT equals the literal (not a substring of a longer string).
  const litRe = new RegExp(`(['"\`])${escapeRegex(literal)}\\1`, 'g');

  for (const [file, content] of cache) {
    const starts = lineStarts(content);
    litRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = litRe.exec(content)) !== null) {
      if (m.index === litRe.lastIndex) litRe.lastIndex += 1;
      const line = lineAt(starts, m.index);
      const text = lineText(content, starts, line);
      const col = m.index - (starts[line - 1] ?? 0);
      const before = text.slice(0, col);
      const after = text.slice(col + m[0].length);
      const role = classifyRole(before, after);
      sites.push({ file, line, role, text: text.trim() });

      // Capture a const alias bound to this literal for the second pass.
      const bind = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=$/.exec(before.replace(/\s+$/, ''));
      if (bind && ALIAS_NAME.test(bind[1]!)) aliasNames.add(bind[1]!);
    }
  }

  // Second pass: classify uses of any const aliased to the literal.
  const resolveAliases = options.resolveAliases !== false;
  if (resolveAliases && aliasNames.size > 0) {
    for (const name of aliasNames) {
      // The lookbehind excludes `.` as well as word chars/`$`: a genuine use of
      // the top-level const alias is never dot-prefixed, whereas `Enum.NAME` /
      // `obj.NAME` is a member/enum accessor that merely shares the alias's name
      // and must NOT be counted as a use of the traced literal (over-match).
      const useRe = new RegExp(`(?<![\\w$.])${escapeRegex(name)}(?![\\w$])`, 'g');
      for (const [file, content] of cache) {
        const starts = lineStarts(content);
        useRe.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = useRe.exec(content)) !== null) {
          const line = lineAt(starts, m.index);
          const text = lineText(content, starts, line);
          const col = m.index - (starts[line - 1] ?? 0);
          const before = text.slice(0, col);
          const after = text.slice(col + name.length);
          // Skip ONLY the binding occurrence itself (`const NAME = …`) — it's
          // already counted as a literal Declare site. Keying on the exact
          // `const NAME` position (not the whole line) means a genuine alias use
          // that merely SHARES a line with some literal is still reported.
          if (/\b(?:const|let|var)\s+$/.test(before)) continue;
          const role = classifyRole(before, after);
          sites.push({ file, line, role, text: text.trim(), viaAlias: name });
        }
      }
    }
  }

  const sortSites = (xs: ITraceSite[]): ITraceSite[] =>
    [...xs].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const byRole: Record<TraceRole, ITraceSite[]> = {
    [TraceRole.Declare]: [],
    [TraceRole.Register]: [],
    [TraceRole.Consume]: [],
    [TraceRole.Reference]: [],
  };
  for (const s of sites) byRole[s.role].push(s);

  return {
    schema: TRACE_SCHEMA,
    literal,
    total: sites.length,
    files: new Set(sites.map((s) => s.file)).size,
    byRole: {
      [TraceRole.Declare]: sortSites(byRole[TraceRole.Declare]),
      [TraceRole.Register]: sortSites(byRole[TraceRole.Register]),
      [TraceRole.Consume]: sortSites(byRole[TraceRole.Consume]),
      [TraceRole.Reference]: sortSites(byRole[TraceRole.Reference]),
    },
    aliases: [...aliasNames].sort(),
  };
}
