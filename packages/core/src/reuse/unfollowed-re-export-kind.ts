/**
 * Why a re-export met during a public-surface walk was not followed to a
 * declaration.
 *
 * - `external`   — it names a module outside the workspace (a bare npm
 *   specifier, an asset): its constructs are not workspace reuse candidates.
 * - `unresolved` — it names a LOCAL module (relative / alias / workspace) the
 *   index has no file for, or a name no indexed file declares: part of the
 *   workspace surface that was NOT measured.
 */
export enum UnfollowedReExportKind {
  External = 'external',
  Unresolved = 'unresolved',
}
