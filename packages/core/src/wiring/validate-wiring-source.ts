import type { ExtractorKind, IWiringSource } from './wiring-rule.ts';

/**
 * Structural validation for one {@link IWiringSource}, with NO filesystem
 * access and no dependencies.
 *
 * It lives in `core` because three layers need the identical answer: the config
 * loader (so a typo fails at load, with a field path), the pack-plane merge seam
 * (so a malformed pack element is skipped rather than crashing resolution), and
 * the engines (so a bad rule degrades to a diagnostic instead of an exception).
 * Two implementations would drift, and a rule that loads but cannot run is
 * exactly the silent-green this plane exists to prevent.
 */

/** Kinds that require an `anchor` naming the construct to locate. */
const ANCHORED: ReadonlySet<string> = new Set([
  'array-members',
  'object-keys',
  'enum-members',
  'call-args',
  'decorator-args',
  'string-union-members',
]);

/** Every valid {@link ExtractorKind}, for schema-level membership checks. */
export const EXTRACTOR_KINDS: readonly ExtractorKind[] = [
  'regex-capture',
  'array-members',
  'object-keys',
  'enum-members',
  'export-names',
  'call-args',
  'decorator-args',
  'string-union-members',
  'json-path',
];

/** The extractor a source resolves to, after applying the legacy sugar. */
export function resolveExtractorKind(source: IWiringSource): ExtractorKind | undefined {
  if (source.extract) return source.extract;
  if (typeof source.pattern === 'string' && source.pattern.length > 0) return 'regex-capture';
  if (typeof source.arrayProperty === 'string' && source.arrayProperty.length > 0) {
    return 'array-members';
  }
  return undefined;
}

/** The construct name a source anchors on, after applying the legacy sugar. */
export function resolveExtractorAnchor(source: IWiringSource): string | undefined {
  if (source.anchor && source.anchor.length > 0) return source.anchor;
  if (source.arrayProperty && source.arrayProperty.length > 0) return source.arrayProperty;
  return undefined;
}

/** Compile a pattern without throwing; returns the error message on failure. */
function compileError(pattern: string, flags?: string): string | undefined {
  try {
    new RegExp(pattern, flags ?? '');
    return undefined;
  } catch (e) {
    return `invalid regular expression /${pattern}/${flags ?? ''}: ${(e as Error).message}`;
  }
}

/** Number of capture groups in a pattern (probe via an always-empty variant). */
function captureGroups(pattern: string): number {
  try {
    return (new RegExp(pattern + '|').exec('')?.length ?? 1) - 1;
  } catch {
    return 1; // can't determine → assume valid
  }
}

/**
 * Validate one source. Returns a human-readable problem, or `undefined` when
 * the source is well-formed.
 */
export function validateWiringSource(source: IWiringSource): string | undefined {
  const hasPattern = typeof source.pattern === 'string' && source.pattern.length > 0;
  const hasArray = typeof source.arrayProperty === 'string' && source.arrayProperty.length > 0;
  // `extract` selects the mode when present; `pattern` / `arrayProperty` are
  // the sugar that selects it when it is absent. Spelling a kind out explicitly
  // ALONGSIDE its own sugar field is consistent, not ambiguous — only a
  // genuine disagreement is an error.
  if (hasPattern && hasArray) {
    return 'sets both `pattern` and `arrayProperty` — set exactly one of `extract`, `pattern`, `arrayProperty`';
  }
  if (source.extract === undefined && !hasPattern && !hasArray) {
    return 'sets no extraction mode — set exactly one of `extract`, `pattern` (regex sugar), `arrayProperty` (array sugar)';
  }
  if (source.extract !== undefined && hasPattern && source.extract !== 'regex-capture') {
    return `sets \`pattern\` with \`extract: "${source.extract}"\` — \`pattern\` is sugar for "regex-capture" only`;
  }
  if (source.extract !== undefined && hasArray && source.extract !== 'array-members') {
    return `sets \`arrayProperty\` with \`extract: "${source.extract}"\` — \`arrayProperty\` is sugar for "array-members" only`;
  }
  if (!source.files || source.files.length === 0) {
    return 'sets no `files` globs — a source that selects no files can only ever match nothing';
  }

  const kind = resolveExtractorKind(source)!;
  if (ANCHORED.has(kind) && resolveExtractorAnchor(source) === undefined) {
    return `extract "${kind}" requires an \`anchor\` naming the construct to locate`;
  }
  if (kind === 'json-path' && !source.jsonPath) {
    return 'extract "json-path" requires a `jsonPath` selector';
  }
  if (kind === 'regex-capture') {
    const err = compileError(source.pattern!, source.flags);
    if (err) return err;
    if (captureGroups(source.pattern!) < 1) {
      return `pattern /${source.pattern}/ has no capture group — group 1 must capture the token`;
    }
  }
  if (source.match !== undefined) {
    const err = compileError(source.match, source.matchFlags);
    if (err) return `match ${err}`;
  }
  if (source.exclude !== undefined) {
    const err = compileError(source.exclude, source.excludeFlags);
    if (err) return `exclude ${err}`;
  }
  if (source.argIndex !== undefined && (!Number.isInteger(source.argIndex) || source.argIndex < 0)) {
    return '`argIndex` must be a non-negative integer';
  }
  return undefined;
}
