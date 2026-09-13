/**
 * One workspace package whose INDEXED record no longer matches the working
 * tree, with what diverged — the detail behind `IGraphFreshness.packagesChanged`
 * (which is exactly the names of these records). A consumer that must decide
 * whether a divergence is EXPLAINED by something it already accounts for (the
 * orphan check: a deleted entry file) reads this; nothing re-derives it.
 */
export interface IPackageEntryDivergence {
  readonly name: string;
  /** The indexed package directory; absent when the package is new since the index. */
  readonly storedDir?: string;
  /** The package directory on disk now; absent when it is no longer a workspace package. */
  readonly currentDir?: string;
  /** The indexed entry file (project-relative), when the index recorded one. */
  readonly storedEntry?: string | null;
  /** What the entry resolves to now (through the SAME resolver the index used). */
  readonly currentEntry?: string | null;
}
