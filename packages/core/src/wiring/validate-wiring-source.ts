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
  'filenames',
  'import-edges',
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

/**
 * The globs a source scans.
 *
 * `files` is optional on the AUTHORING shape (a `$use` source inherits it), but
 * every engine runs on a RESOLVED source where it is always present. This
 * accessor is the one place that states that: engines read globs through it and
 * an unresolved source degrades to "scans nothing" — which every plane then
 * reports as a loud zero-match, never as a silent pass.
 */
export function resolveSourceGlobs(source: IWiringSource): readonly string[] {
  return source.files ?? [];
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
    return 'sets no `files` globs — a source that selects no files can only ever match nothing (set `files`, or `$use` a named extractor that supplies them)';
  }

  const kind = resolveExtractorKind(source)!;
  if (ANCHORED.has(kind) && resolveExtractorAnchor(source) === undefined) {
    return `extract "${kind}" requires an \`anchor\` naming the construct to locate`;
  }
  if (kind === 'json-path' && !source.jsonPath) {
    return 'extract "json-path" requires a `jsonPath` selector';
  }
  if (kind === 'filenames') {
    if (source.capturePath === 'regex') {
      if (!source.pathPattern) {
        return 'extract "filenames" with `capturePath: "regex"` requires a `pathPattern` whose group 1 captures the id';
      }
      const err = compileError(source.pathPattern, source.pathPatternFlags);
      if (err) return `pathPattern ${err}`;
      if (captureGroups(source.pathPattern) < 1) {
        return `pathPattern /${source.pathPattern}/ has no capture group — group 1 must capture the id`;
      }
    } else if (source.pathPattern !== undefined) {
      return '`pathPattern` only applies with `capturePath: "regex"`';
    }
  }
  if (kind === 'import-edges') {
    // A rule that selects EVERY import in the scanned tree is almost never what
    // the author meant, and it would quietly pin an enormous set. Requiring a
    // selector makes the intent explicit.
    const t = source.to;
    const hasTarget =
      t !== undefined &&
      (t.module !== undefined || t.modulePattern !== undefined || (t.files?.length ?? 0) > 0 || t.match !== undefined);
    if (!hasTarget) {
      return 'extract "import-edges" requires a `to` selector (`module`, `modulePattern`, `files`, or `match`) — otherwise it would pin every import in the scanned tree';
    }
    for (const [field, pattern, flags] of [
      ['to.modulePattern', t.modulePattern, t.modulePatternFlags],
      ['to.match', t.match, t.matchFlags],
    ] as const) {
      if (pattern === undefined) continue;
      const err = compileError(pattern, flags);
      if (err) return `${field} ${err}`;
    }
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
