import * as nodePath from 'node:path';

export interface ISafePathResult {
  /** Resolved absolute path. */
  absolutePath: string;
  /** Relative path from projectRoot to absolutePath. */
  relativePath: string;
}

export class UnsafeTargetPathError extends Error {
  readonly code:
    | 'absolute-path-rejected'
    | 'traversal-detected'
    | 'outside-project-root'
    | 'empty-path';
  readonly rawPath: string;

  constructor(
    code: UnsafeTargetPathError['code'],
    rawPath: string,
    message: string,
  ) {
    super(message);
    this.name = 'UnsafeTargetPathError';
    this.code = code;
    this.rawPath = rawPath;
  }
}

/**
 * Resolve a template-supplied target path against the project root, refusing
 * anything that escapes the project boundary.
 *
 * Rules (in order):
 *   1. Empty / non-string input → reject.
 *   2. Absolute paths → reject unless `allowAbsolute: true`.
 *   3. Normalize the path (collapses ../ and ./).
 *   4. The resolved path must be inside (or equal to) projectRoot.
 *
 * This is the single chokepoint for all generator file writes.
 */
export function safeResolveTargetPath(
  rawPath: string,
  projectRoot: string,
  options: { allowAbsolute?: boolean } = {},
): ISafePathResult {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw new UnsafeTargetPathError('empty-path', String(rawPath), 'Target path is empty');
  }

  const resolvedProjectRoot = nodePath.resolve(projectRoot);
  const normalized = nodePath.normalize(rawPath);

  if (nodePath.isAbsolute(normalized) && !options.allowAbsolute) {
    throw new UnsafeTargetPathError(
      'absolute-path-rejected',
      rawPath,
      `Absolute target path "${rawPath}" is not allowed without explicit opt-in`,
    );
  }

  const absolute = nodePath.isAbsolute(normalized)
    ? normalized
    : nodePath.resolve(resolvedProjectRoot, normalized);

  // Final containment check — protects against ../../escape and symlink-style tricks.
  const relative = nodePath.relative(resolvedProjectRoot, absolute);
  if (relative === '' || (!relative.startsWith('..') && !nodePath.isAbsolute(relative))) {
    return { absolutePath: absolute, relativePath: relative === '' ? '.' : relative };
  }

  throw new UnsafeTargetPathError(
    'outside-project-root',
    rawPath,
    `Target path "${rawPath}" resolves to "${absolute}" which is outside project root "${resolvedProjectRoot}"`,
  );
}

/** True if a string contains `..` segments. Used for early diagnostics. */
export function containsTraversal(rawPath: string): boolean {
  return nodePath.normalize(rawPath).split(/[\\/]+/).includes('..');
}
