export interface ISafePathResult {
    /** Resolved absolute path. */
    absolutePath: string;
    /** Relative path from projectRoot to absolutePath. */
    relativePath: string;
}
export declare class UnsafeTargetPathError extends Error {
    readonly code: 'absolute-path-rejected' | 'traversal-detected' | 'outside-project-root' | 'empty-path';
    readonly rawPath: string;
    constructor(code: UnsafeTargetPathError['code'], rawPath: string, message: string);
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
export declare function safeResolveTargetPath(rawPath: string, projectRoot: string, options?: {
    allowAbsolute?: boolean;
}): ISafePathResult;
/** True if a string contains `..` segments. Used for early diagnostics. */
export declare function containsTraversal(rawPath: string): boolean;
//# sourceMappingURL=safe-target-path.d.ts.map