import type { UnfollowedReExportKind } from './unfollowed-re-export-kind.ts';

/**
 * One re-export a public-surface walk could not follow to an indexed
 * declaration — listed, never dropped, so a caller can tell "the surface has no
 * such name" from "that part of the surface was never measured".
 */
export interface IUnfollowedReExport {
  /** Workspace package whose entry walk met it. */
  readonly package: string;
  /** Project-relative file that declares the re-export. */
  readonly file: string;
  /** The module specifier as written (`./gone`, `lodash`). */
  readonly specifier: string;
  /** The exposed name, or `*` for an `export * from` that was not followed. */
  readonly name: string;
  readonly kind: UnfollowedReExportKind;
}
