import { isNegatedGlob, parseGlobList, type IGlobList } from '@shrkcrft/core';
import type { IGlobUnitMeasure } from './i-glob-unit-measure.ts';

/**
 * Minimal glob matcher tuned for the patterns boundary rules use:
 *   - `**` matches any number of path segments (including zero)
 *   - `*`  matches any chars except `/`
 *   - `?`  matches a single char except `/`
 *   - everything else is literal
 *
 * Patterns are matched against the literal string (file path or import
 * specifier) — no I/O, no resolution. The function is pure and deterministic.
 *
 * Compiled patterns are MEMOISED (round 11, 6.3): `matchesAny` used to
 * recompile a pattern on every test, once per edge × pattern, and that was the
 * dominant cost of a boundary run at scale (1.5 s → 0.09 s at 300 rules). The
 * returned RegExp has no `g`/`y` flag, so sharing one instance is stateless.
 * The cache is bounded ({@link GLOB_REGEX_CACHE_LIMIT}) and simply cleared when
 * full — a pattern set larger than that is recompiled, never wrong.
 */
export function globToRegex(pattern: string): RegExp {
  const cached = GLOB_REGEX_CACHE.get(pattern);
  if (cached) return cached;
  if (GLOB_REGEX_CACHE.size >= GLOB_REGEX_CACHE_LIMIT) GLOB_REGEX_CACHE.clear();
  const compiled = compileGlob(pattern);
  GLOB_REGEX_CACHE.set(pattern, compiled);
  return compiled;
}

/** The most compiled globs {@link globToRegex} keeps before it starts over. */
export const GLOB_REGEX_CACHE_LIMIT = 10_000;

const GLOB_REGEX_CACHE = new Map<string, RegExp>();

/** How many compiled globs are memoised right now (bounded by {@link GLOB_REGEX_CACHE_LIMIT}). */
export function globRegexCacheSize(): number {
  return GLOB_REGEX_CACHE.size;
}

function compileGlob(pattern: string): RegExp {
  let r = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === '*') {
      // ** vs *
      const next = pattern[i + 1];
      if (next === '*') {
        // ** — zero or more segments
        // Also consume a trailing `/` so `a/** /b` matches `a/b`.
        const after = pattern[i + 2];
        if (after === '/') {
          r += '(?:.*/)?';
          i += 2;
        } else {
          r += '.*';
          i += 1;
        }
      } else {
        r += '[^/]*';
      }
      continue;
    }
    if (ch === '?') {
      r += '[^/]';
      continue;
    }
    // Escape regex special chars.
    if ('.+^$|(){}[]\\'.includes(ch)) {
      r += '\\' + ch;
      continue;
    }
    r += ch;
  }
  return new RegExp('^' + r + '$');
}

/**
 * The raw OR primitive: does ANY pattern match `value`? A `!` is a literal
 * character here, so it is right for import specifiers and plain pattern sets,
 * and WRONG for a user-written glob list — use {@link globListSelects} there.
 */
export function matchesAny(value: string, patterns: readonly string[]): boolean {
  for (const p of patterns) {
    if (globToRegex(p).test(value)) return true;
  }
  return false;
}

/** Parsed lists that carry a negation, keyed by the list's text (bounded like the regex cache). */
const GLOB_LIST_CACHE = new Map<string, IGlobList>();

function hasNegation(globs: readonly string[]): boolean {
  for (const g of globs) if (isNegatedGlob(g)) return true;
  return false;
}

/**
 * A list's inclusion globs and negations (`!` stripped), through core's one
 * parser. Memoised by the list's TEXT (its JSON, so no two lists share a key),
 * never by array identity — a caller that builds a list and then pushes to it
 * must not read a stale parse.
 */
export function globListParts(globs: readonly string[]): IGlobList {
  if (!hasNegation(globs)) return { include: globs, exclude: [] };
  const key = JSON.stringify(globs);
  const cached = GLOB_LIST_CACHE.get(key);
  if (cached) return cached;
  if (GLOB_LIST_CACHE.size >= GLOB_REGEX_CACHE_LIMIT) GLOB_LIST_CACHE.clear();
  const parsed = parseGlobList(globs);
  GLOB_LIST_CACHE.set(key, parsed);
  return parsed;
}

/**
 * THE scope test for a user-written glob list, on every gate plane: `path` is
 * selected iff one of the list's inclusion globs matches it and none of its
 * negations does.
 *
 * Order-independent (a later glob never re-includes) and LIST-LOCAL: a
 * negation subtracts from its own list's positive set only. That is why a walk
 * is never negation-aware ({@link globListWalkGlobs}): planes walk the UNION of
 * many lists once, and a negation applied there would delete rule A's `!x`
 * from rule B's scope. Selection happens per list, after the walk.
 */
export function globListSelects(path: string, globs: readonly string[]): boolean {
  if (!hasNegation(globs)) return matchesAny(path, globs);
  const list = globListParts(globs);
  return matchesAny(path, list.include) && !matchesAny(path, list.exclude);
}

/**
 * The globs a WALK over `globs` must match: the inclusion globs only. A walk
 * is a positive union primitive (see {@link globListSelects}); what a list's
 * negations remove is decided per list, over what the walk returned.
 */
export function globListWalkGlobs(globs: readonly string[]): readonly string[] {
  return globListParts(globs).include;
}

/**
 * What each glob of ONE list did to `paths`, in first-seen order (a glob listed
 * twice is measured once). See {@link IGlobUnitMeasure}: an inclusion glob's
 * `effective` count is what it selected that survives the list's negations; a
 * negation's is what it removed from the list's positive set.
 *
 * `paths` may be a wider walk than this list's own (a union over many rules):
 * only the paths one of THIS list's inclusion globs matches are its positive
 * set, so another list's files never count as excluded here.
 */
export function measureGlobList(paths: readonly string[], globs: readonly string[]): readonly IGlobUnitMeasure[] {
  const list = globListParts(globs);
  const positive = list.exclude.length === 0 ? undefined : paths.filter((p) => matchesAny(p, list.include));
  const selected = positive?.filter((p) => !matchesAny(p, list.exclude));
  const out: IGlobUnitMeasure[] = [];
  const seen = new Set<string>();
  for (const glob of globs) {
    if (seen.has(glob)) continue;
    seen.add(glob);
    if (isNegatedGlob(glob)) {
      const re = globToRegex(glob.slice(1));
      let excluded = 0;
      for (const p of positive ?? []) if (re.test(p)) excluded += 1;
      out.push({ glob, negation: true, matched: excluded, effective: excluded });
      continue;
    }
    const re = globToRegex(glob);
    let matched = 0;
    for (const p of paths) if (re.test(p)) matched += 1;
    let effective = matched;
    if (selected !== undefined) {
      effective = 0;
      for (const p of selected) if (re.test(p)) effective += 1;
    }
    out.push({ glob, negation: false, matched, effective });
  }
  return out;
}

/** A project-relative directory path without `./` or trailing slashes (`''` is the root). */
function normaliseDirPath(dir: string): string {
  let d = dir;
  if (d === '.' || d === './') return '';
  if (d.startsWith('./')) d = d.slice(2);
  return d.replace(/\/+$/, '');
}

/**
 * Could `glob` match some path strictly BENEATH directory `dir` (project-
 * relative, `/`-separated; a trailing `/` is optional and `./` is the root)?
 *
 * The question an unlistable directory asks: its files were never enumerated,
 * so a rule is in front of it whenever a path under it COULD be in the rule's
 * scope. Segment-wise and deliberately one-directional: a `**` absorbs the
 * rest, so a false "yes" is possible (a gap reported that a full listing might
 * have ruled out) and a false "no" is not — `src/app/*.ts` cannot reach
 * `src/app/sub/`, `src/app/**` and `**\/*.ts` can.
 */
export function globMayMatchUnder(glob: string, dir: string): boolean {
  const d = normaliseDirPath(dir);
  const dirSegs = d === '' ? [] : d.split('/');
  const globSegs = glob.split('/');
  for (let i = 0; i < globSegs.length; i += 1) {
    const segment = globSegs[i]!;
    if (segment.includes('**')) return true;
    // The directory is consumed and the glob has segments left for a file beneath it.
    if (i >= dirSegs.length) return true;
    if (!globToRegex(segment).test(dirSegs[i]!)) return false;
  }
  // The glob ended at (or above) the directory: nothing strictly beneath it matches.
  return false;
}

/**
 * Does `glob` match EVERY path beneath directory `dir`? True for `**`, and for
 * a glob ending in `/**` whose base matches the directory or one of its
 * ancestors (`src/generated/**` covers `src/generated/` and
 * `src/generated/deep/`). The test an exemption must pass to take an
 * unlistable directory out of a rule's scope: exempting PART of it leaves the
 * rest a gap. Conservative — any other shape answers `false`.
 */
export function globCoversAllUnder(glob: string, dir: string): boolean {
  if (glob === '**') return true;
  if (!glob.endsWith('/**')) return false;
  const base = glob.slice(0, -3);
  const d = normaliseDirPath(dir);
  if (d === '') return false;
  const segs = d.split('/');
  for (let n = segs.length; n >= 1; n -= 1) {
    if (globToRegex(base).test(segs.slice(0, n).join('/'))) return true;
  }
  return false;
}

/**
 * How many of `paths` each glob of ONE list effectively counts for, keyed by
 * glob in first-seen order (a glob listed twice is counted once): an inclusion
 * glob's selected files (those surviving the list's negations), a negation's
 * EXCLUDED files. The `glob → effective` projection of {@link measureGlobList}.
 *
 * `globListSelects` collapses a glob LIST into one yes/no, which is right for
 * "is this file in scope" and exactly wrong for "is every glob still live": one
 * glob of a rule's `files[]` can match nothing after a directory rename while
 * its siblings keep the rule connected, and the rule reads green forever. A
 * zero here is that dead unit — and, since round 12, a negation is judged by
 * what it EXCLUDES, so a load-bearing `!**\/*.spec.ts` is never a zero. Pure —
 * callers pass the file list their own walk produced.
 */
export function countMatchesPerGlob(
  paths: readonly string[],
  globs: readonly string[],
): ReadonlyMap<string, number> {
  return new Map(measureGlobList(paths, globs).map((m) => [m.glob, m.effective]));
}
