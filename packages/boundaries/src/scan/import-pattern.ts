import type { BoundaryMatchKind, ForbiddenMatchMode } from '../model/boundary-rule.ts';
import { globToRegex } from './glob.ts';
import { nodeBuiltinPackageNames } from './node-builtin-package-names.ts';

/**
 * How a forbidden-import (or exception-target) pattern matches an import
 * specifier — the pattern language of the boundary plane (round 11, 1.5).
 *
 * The generic glob matcher keeps `*` = "any chars except `/`" (glob.test.ts
 * pins that), so a bare package pattern like `@scope/package-a` or
 * `@scope/package-*` used to match ONLY the package entrypoint: every subpath
 * import of the very same forbidden package (`@scope/package-a/sub`) escaped
 * the fence, and the gate reported green over it. Package semantics live HERE,
 * in the boundary evaluator's matcher, not in glob.ts.
 *
 * The rule, in one sentence: a pattern with no `**` and no trailing `/` is a
 * PACKAGE pattern — it matches the specifier itself and everything under it
 * (`<pattern>/**`), at a segment boundary, so `@scope/pkg` covers
 * `@scope/pkg/deep` but never `@scope/pkg-legacy`. A pattern containing `**`
 * already says how deep it reaches and is matched exactly as written. A rule
 * that means "the entrypoint only" (barrel avoidance: forbid `lodash`, allow
 * `lodash/get`) opts out with `forbiddenMatch: 'exact'`.
 */

/** Does `pattern` take package semantics (entrypoint + every subpath)? */
export function isPackagePattern(pattern: string): boolean {
  return !pattern.includes('**') && !pattern.endsWith('/');
}

/**
 * Match `specifier` against `pattern`.
 *
 * Returns `'exact'` when the pattern matches the specifier as written,
 * `'subpath'` when only the package semantics reached it (a deeper import of a
 * package the pattern names), and `null` otherwise. `mode: 'exact'` disables
 * the subpath half. The verdict label travels on the violation (`matchKind`)
 * so a newly-reported subpath edge explains itself.
 */
export function matchImportPattern(
  specifier: string,
  pattern: string,
  mode: ForbiddenMatchMode = 'package',
): BoundaryMatchKind | null {
  if (globToRegex(pattern).test(specifier)) return 'exact';
  if (mode === 'package' && isPackagePattern(pattern) && globToRegex(`${pattern}/**`).test(specifier)) {
    return 'subpath';
  }
  return null;
}

/**
 * Why `pattern` cannot mean what its author wrote in a SPECIFIER list
 * (`forbiddenImports`, `allowedImports`, `exceptions[].target`) matched under
 * `mode` — or `undefined` for a well-formed pattern (round 12, R12-5.2). The
 * one predicate the rule validator (every local AND pack rule file) and the
 * evaluator's dead-unit reach both read.
 *
 *   - `''` names no import.
 *   - A leading `!` is the NEGATION syntax of every glob list in this repo, but
 *     a specifier list takes none: compiled as written it matches only an
 *     import that itself starts with `!` (a webpack inline loader), so the
 *     carve-out an author meant silently matched nothing. (A literal
 *     inline-loader specifier is still reachable: start the pattern with `?`.)
 *   - Under package semantics a trailing `/` is the one spelling left literal
 *     ({@link isPackagePattern}): it matches only an import written WITH that
 *     slash (`'buffer/'`, the userland-polyfill idiom) — never the package, never
 *     its subpaths — while the gate reported ✓ over both. `mode: 'exact'` (and
 *     `allowedImports`, always exact) keeps it as the literal it then plainly is.
 *
 * Deliberately NOT "can never match": `'buffer/'` is a real import specifier.
 * The trailing-slash fix it names is lossless — the package spelling covers
 * the slash spelling too (`matchImportPattern('buffer/', 'buffer')` is
 * `subpath`), so following the advice never narrows a fence.
 */
export function importPatternDefect(pattern: string, mode: ForbiddenMatchMode = 'package'): string | undefined {
  if (pattern.length === 0) return 'an empty pattern names no import';
  if (pattern.startsWith('!')) {
    return (
      'negation is only supported in `from` — a specifier list takes no "!" (as written this matches only an import that itself starts with "!"). ' +
      'forbiddenImports is checked before allowedImports, so allowedImports never re-admits a forbidden import: carve a subpath out with exceptions[{ path, target, reason }], ' +
      "or set forbiddenMatch: 'exact' and list exactly what you forbid"
    );
  }
  if (mode === 'package' && pattern.endsWith('/')) {
    const bare = pattern.replace(/\/+$/, '');
    const fix =
      bare.length === 0
        ? 'name a package or a path'
        : isPackagePattern(bare)
          ? `write '${bare}' (the package and every subpath — '${pattern}' included) or '${bare}/**' (subpaths only)`
          : `write '${bare}'`;
    return `a trailing '/' matches only an import written with that slash, never the package or its subpaths — ${fix}; forbiddenMatch: 'exact' keeps '${pattern}' as a literal`;
  }
  return undefined;
}

/**
 * Does every specifier `inner` matches also match `outer`? (round 12, R12-5.3 /
 * R12-5.6). `outerMode` is how `outer` matches (the rule's `forbiddenMatch`);
 * `innerMode` is how `inner` does — the same mode for a sibling forbidden
 * pattern, `exact` for an `allowedImports` entry (never widened).
 *
 * Deliberately CONSERVATIVE — `true` only when the literal shape proves it,
 * because a false "covered" would tell an author to delete a live pattern (or
 * call a working allowance dead). Two proofs:
 *
 *   1. `inner` is a literal (no `*` / `?`) that `outer` matches — and, when
 *      `inner` itself widens to its subpaths (a package pattern under package
 *      semantics), `outer` widens too.
 *   2. `outer` is a package pattern under package semantics, and it matches
 *      `inner`'s literal prefix up to one of its `/`: every specifier `inner`
 *      can match starts with that prefix plus `/`, a subpath `outer` covers.
 *
 * A pattern with an {@link importPatternDefect} proves nothing either way.
 */
export function importPatternSubsumes(
  outer: string,
  inner: string,
  outerMode: ForbiddenMatchMode = 'package',
  innerMode: ForbiddenMatchMode = outerMode,
): boolean {
  if (importPatternDefect(outer, outerMode) !== undefined) return false;
  if (importPatternDefect(inner, innerMode) !== undefined) return false;
  const outerWidens = outerMode === 'package' && isPackagePattern(outer);
  const wild = inner.search(/[*?]/);
  if (wild === -1) {
    if (matchImportPattern(inner, outer, outerMode) === null) return false;
    const innerWidens = innerMode === 'package' && isPackagePattern(inner);
    return !innerWidens || outerWidens;
  }
  if (!outerWidens) return false;
  const prefix = inner.slice(0, wild);
  for (let k = prefix.indexOf('/'); k > 0; k = prefix.indexOf('/', k + 1)) {
    if (matchImportPattern(prefix.slice(0, k), outer, 'package') !== null) return true;
  }
  return false;
}

/** Why the dead-unit judge never calls a relative specifier pattern dead — its went-live evidence and the marker refusal both quote it. */
export const RELATIVE_PATTERN_NEVER_DEAD =
  'a relative pattern is never judged dead (it cannot be judged without an importing file)';

/** Why the dead-unit judge never calls a leading-`*` specifier pattern dead — its went-live evidence and the marker refusal both quote it. */
export const LEADING_WILDCARD_NEVER_DEAD =
  'a leading wildcard could match any known package name, so it is never judged dead';

/**
 * Could `pattern` match an import of package `name` (or one of its subpaths)?
 * Deliberately permissive — a false "resolvable" costs a missed warning, a false
 * "dead" would cry wolf on a legitimate guard. The evaluator's reach
 * (`resolvedBy`) and {@link importPatternNeverJudgedDead} both read it.
 */
export function couldMatchPackageName(pattern: string, name: string, mode: ForbiddenMatchMode): boolean {
  if (matchImportPattern(name, pattern, mode) !== null) return true;
  const wild = pattern.search(/[*?]/);
  if (wild === -1) return pattern.startsWith(`${name}/`);
  const prefix = pattern.slice(0, wild);
  if (prefix.length === 0) {
    // A leading `*` could be anything. A leading `?` is exactly ONE character:
    // the literal after the `?` run must still fit the name at that offset —
    // so `?!raw-loader!**` (an inline-loader pattern) can never match a package
    // name, and one that matches no import is a dead unit, not "resolvable"
    // through every known package (round 12 review, R12-DOC-1).
    const lead = pattern.length - pattern.replace(/^\?+/, '').length;
    if (lead === 0) return true;
    const literal = pattern.slice(lead).split(/[*?]/)[0] ?? '';
    const rest = name.slice(lead);
    return literal.length === 0 || rest.startsWith(literal) || literal.startsWith(`${rest}/`);
  }
  return name.startsWith(prefix) || prefix.startsWith(`${name}/`);
}

/**
 * Why the boundary dead-unit judge can NEVER call `pattern` dead, matched
 * under `mode` — or `undefined` when it can (round 13, K5). Proved from the
 * pattern alone, through the judge's own reach rules (`resolvedBy` in the
 * evaluator): the judge calls a specifier pattern dead only when it resolves to
 * nothing anywhere, and the orchestrator ALWAYS supplies the runtime builtins
 * as known packages (`nodeBuiltinPackageNames`), so these always resolve:
 *
 *   - a relative pattern (`./x`, `../legacy/**`) — never judged without an
 *     importing file;
 *   - a leading `*` — it could match any known package name, and a builtin is
 *     always known;
 *   - a pattern a runtime builtin module matches (`fs`, `node:*`,
 *     `fs/promises`) — that package always exists.
 *
 * A `{ pattern, expectEmpty: true }` marker on such a pattern could only ever
 * read went-live, so the rule validator refuses it at load. A pattern with an
 * {@link importPatternDefect} is answered by the defect instead (`undefined`).
 */
export function importPatternNeverJudgedDead(pattern: string, mode: ForbiddenMatchMode = 'package'): string | undefined {
  if (importPatternDefect(pattern, mode) !== undefined) return undefined;
  if (pattern.startsWith('.')) return RELATIVE_PATTERN_NEVER_DEAD;
  if (pattern.startsWith('*')) return LEADING_WILDCARD_NEVER_DEAD;
  const builtins = nodeBuiltinPackageNames();
  const builtin =
    builtins.find((b) => matchImportPattern(b, pattern, mode) !== null) ??
    builtins.find((b) => couldMatchPackageName(pattern, b, mode));
  return builtin !== undefined
    ? `'${builtin}' is a runtime builtin module — always a known package — so it always resolves and is never judged dead`
    : undefined;
}
