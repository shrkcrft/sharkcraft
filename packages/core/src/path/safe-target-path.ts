import * as nodeFs from 'node:fs';
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
 * Resolve the symlink-aware real location of `absPath` by realpath-resolving
 * its deepest *existing* ancestor and re-attaching the not-yet-created tail.
 *
 * A lexical containment check (`relative(root, abs)` has no `..`) can be
 * fooled by an in-root symlink — e.g. `root/linkdir -> ../outside` makes
 * `root/linkdir/secret` look contained while it physically lives outside the
 * sandbox. Resolving the deepest existing ancestor unmasks that escape.
 *
 * Returns `null` when no ancestor can be realpath-resolved (e.g. the path's
 * filesystem root cannot be probed); callers then fall back to the lexical
 * guarantee rather than rejecting. Pure read; never mutates the filesystem.
 */
function realResolveDeepestAncestor(absPath: string): string | null {
  let existing = absPath;
  const tail: string[] = [];
  while (!nodeFs.existsSync(existing)) {
    const parent = nodePath.dirname(existing);
    if (parent === existing) {
      // Walked up to the filesystem root without finding anything on disk.
      return null;
    }
    tail.unshift(nodePath.basename(existing));
    existing = parent;
  }
  let real: string;
  try {
    real = nodeFs.realpathSync(existing);
  } catch {
    return null;
  }
  return tail.length === 0 ? real : nodePath.join(real, ...tail);
}

/**
 * True when `absPath` — although it may be lexically inside `projectRoot` —
 * physically resolves (through one or more symlinks) to a location outside
 * the project root. This is the realpath-aware companion to the lexical
 * containment check and the only guard that catches an in-root symlink that
 * escapes the sandbox.
 *
 * Conservatively returns `false` when containment cannot be determined from
 * the filesystem (e.g. the project root does not exist on disk), so the
 * caller's lexical check remains authoritative in that case.
 */
export function pathEscapesRootViaSymlink(
  projectRoot: string,
  absPath: string,
): boolean {
  let realRoot: string;
  try {
    realRoot = nodeFs.realpathSync(nodePath.resolve(projectRoot));
  } catch {
    return false;
  }
  const realTarget = realResolveDeepestAncestor(absPath);
  if (realTarget === null) return false;
  if (realTarget === realRoot) return false;
  const rel = nodePath.relative(realRoot, realTarget);
  return rel === '..' || rel.startsWith('..' + nodePath.sep) || nodePath.isAbsolute(rel);
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

  // Lexical containment check — protects against ../../escape.
  const relative = nodePath.relative(resolvedProjectRoot, absolute);
  if (relative === '' || (!relative.startsWith('..') && !nodePath.isAbsolute(relative))) {
    // Realpath-aware containment — a lexically-clean path can still traverse an
    // in-root symlink (e.g. linkdir -> ../outside) out of the sandbox.
    if (pathEscapesRootViaSymlink(resolvedProjectRoot, absolute)) {
      throw new UnsafeTargetPathError(
        'outside-project-root',
        rawPath,
        `Target path "${rawPath}" resolves through a symlink to a location outside project root "${resolvedProjectRoot}" (symlink escape)`,
      );
    }
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
