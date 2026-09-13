import type { IPublicExport, IUnfollowedReExport } from '@shrkcrft/core';

/**
 * What ONE module exposes to `import … from '<it>'`, walked with ESM export
 * resolution (`createModuleExportWalker`). The public surface is this walk run
 * from every package root; a curated `importPath` that is not a package root
 * is checked with the same walk — so "is it exported, and as the default or a
 * named export?" has one answer.
 */
export interface IModuleExportWalk {
  /** The module (project-relative) the walk started from. */
  readonly file: string;
  /** Exposed constructs, in walk order; `package` / `entryFile` are the caller's to fill. */
  readonly exports: readonly Omit<IPublicExport, 'package' | 'entryFile'>[];
  /** Re-exports met that did not land on an indexed declaration; `package` is the caller's to fill. */
  readonly unfollowed: readonly Omit<IUnfollowedReExport, 'package'>[];
}
