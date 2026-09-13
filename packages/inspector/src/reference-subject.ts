import type { IAssetReference } from '@shrkcrft/core';
import type { IKnowledgeAnchor } from '@shrkcrft/knowledge';
import type { ReferenceAssetKind } from './reference-asset-kind.ts';

/**
 * Anything the staleness sweep verifies references for: a knowledge entry, a
 * boundary rule, or a declared policy check. The sweep's per-subject loop is
 * written once against this shape, so every asset kind is checked by the same
 * reference checker — never a second one that drifts.
 */
export interface IReferenceSubject {
  readonly assetKind: ReferenceAssetKind;
  readonly id: string;
  /** Where it is declared, relative to the project root, when known. */
  readonly source?: string;
  /** Knowledge `type`, for knowledge subjects. */
  readonly type?: string;
  readonly references: readonly IAssetReference[];
  readonly anchors?: readonly IKnowledgeAnchor[];
}
