import type { IPublicExport } from './public-export.ts';
import type { IUnfollowedReExport } from './unfollowed-re-export.ts';

/**
 * The workspace's public export surface: every construct reachable from a
 * workspace package's root entry, plus an honest account of what could NOT be
 * walked.
 *
 * A package whose entry the index cannot resolve is listed in
 * `packagesWithoutEntry` with a reason — never dropped silently — so a caller
 * can report its exports as NOT measured rather than as absent.
 */
export interface IPublicExportSurface {
  /** Packages whose root entry is an indexed file — the walk started here. */
  readonly roots: readonly {
    readonly package: string;
    /** Package directory (project-relative). */
    readonly dir: string;
    readonly entryFile: string;
  }[];
  /** Packages that were NOT walked, each with why. */
  readonly packagesWithoutEntry: readonly {
    readonly package: string;
    readonly dir: string;
    readonly reason: string;
  }[];
  /** Deduped by (package, name); sorted by package, then name. */
  readonly exports: readonly IPublicExport[];
  /**
   * Re-exports met during the walk that did not land on an indexed
   * declaration (an external or unresolved specifier, a name no file
   * declares) — their names are NOT on the surface. Always
   * `unfollowedReExports.length`.
   */
  readonly unresolvedReExports: number;
  /**
   * Each of those re-exports, classified: `external` (a module outside the
   * workspace — not a reuse candidate) vs `unresolved` (a local module or name
   * the index could not follow — part of the surface that was NOT measured).
   */
  readonly unfollowedReExports: readonly IUnfollowedReExport[];
}
