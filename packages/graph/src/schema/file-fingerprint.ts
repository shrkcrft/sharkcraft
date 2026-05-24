/**
 * Per-file fingerprint used for incremental indexing.
 *
 * MVP uses mtime + sha1(content). Falling back to sha1-only is fine when
 * mtime is unreliable (e.g., docker bind mounts on Linux). The store keeps
 * both so the comparison is cheap.
 */
export interface IFileFingerprint {
  /** Project-relative path. */
  path: string;
  /** ms since epoch. */
  mtime: number;
  /** SHA-1 of file contents, hex. */
  sha1: string;
  /** File size in bytes. */
  sizeBytes: number;
  /** Resolved language tag, e.g. 'typescript' | 'javascript'. */
  language: string;
  /** Node id this file owns in the graph. */
  nodeId: string;
}
