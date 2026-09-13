import type { ReuseImportStyle } from '@shrkcrft/core';

/**
 * One curated `reusePrimitives[]` entry resolved against the code — THE record
 * `shrk reuse` prints a curated row from and `shrk reuse coverage` judges it
 * by (`resolveCuratedReuse`), so the two can never disagree about which
 * construct an entry names or whether its import compiles.
 */
export interface IReuseCuratedResolution {
  /**
   * The declaration the entry names: the construct its `importPath` resolves
   * to, else (among the name's declarations) one on the public surface, then an
   * exported one, then the first by path. Absent when nothing declares it (or
   * there is no graph to ask).
   */
  readonly declaration?: {
    readonly path: string;
    readonly symbolId: string;
    readonly isExported: boolean;
    readonly line?: number;
    readonly declKind?: string;
  };
  /** Other files declaring the same name (exported ones when any are). */
  readonly alternates: readonly string[];
  /** How the printed import binds the symbol (set whenever `importPath` is). */
  readonly importStyle?: ReuseImportStyle;
  /** The copy-paste import line (set whenever `importPath` is). */
  readonly importLine?: string;
  /**
   * `true` / `false` when `importPath` was checked: does the module it names
   * export the symbol, so `importLine` compiles? Absent when it could not be
   * checked (see `importPathNote`) or there is no graph.
   */
  readonly importPathAgrees?: boolean;
  readonly importPathNote?: string;
}
