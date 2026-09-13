import type { IAssetReference } from '@shrkcrft/core';

/**
 * A declared policy check, read WITHOUT running it — the data the reference
 * resolver and the staleness sweep need. Filled by the same load that lists
 * policy ids, so there is one reader of the declarations.
 */
export interface IPolicyDeclaration {
  /** The bare id the author declared. */
  readonly id: string;
  /** The id `evaluatePolicy` reports at runtime (`local:<id>` / `pack:<pkg>:<id>`). */
  readonly qualifiedId: string;
  readonly source: 'local' | 'pack';
  /** Absolute path of the declaring file. */
  readonly sourceFile: string;
  /** Declared references, when the check carries any. */
  readonly references?: readonly IAssetReference[];
}
