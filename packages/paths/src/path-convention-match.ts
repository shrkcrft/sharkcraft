import type { IPathConvention } from './path-convention.ts';

/** Normalise a path for prefix comparison: drop leading `./` or `/`, drop a
 *  trailing slash, collapse separators to POSIX `/`. */
function normalizePath(p: string): string {
  return p
    .replace(/^\.?\/+/, '')
    .replace(/\/+$/, '')
    .split(/[\\/]+/)
    .filter(Boolean)
    .join('/');
}

/**
 * Select the path conventions a set of files actually falls under, by STRUCTURED
 * directory-prefix match against each convention's `metadata.path` — not a
 * free-text substring of its title/description (which made common segments like
 * `src` match nearly the whole registry).
 *
 * A convention is "affected" iff some file equals, or lives under, its canonical
 * path. Conventions with no structured `metadata.path` are excluded (they have
 * no anchor to attribute against). Returns conventions in input order.
 */
export function matchAffectedConventions(
  conventions: readonly IPathConvention[],
  files: readonly string[],
): IPathConvention[] {
  const normFiles = files.map(normalizePath).filter((f) => f.length > 0);
  const out: IPathConvention[] = [];
  for (const convention of conventions) {
    const normConv = normalizePath(String(convention.metadata?.path ?? ''));
    if (normConv.length === 0) continue;
    const affected = normFiles.some((f) => f === normConv || f.startsWith(normConv + '/'));
    if (affected) out.push(convention);
  }
  return out;
}
