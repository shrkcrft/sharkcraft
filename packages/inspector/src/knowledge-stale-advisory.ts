import type { IAssetReference } from '@shrkcrft/core';
import type { KnowledgeAdvisoryCode } from './knowledge-advisory-code.ts';
import type { ReferenceAssetKind } from './reference-asset-kind.ts';

/** One advisory from a staleness sweep — reported, never gating by itself. */
export interface IKnowledgeStaleAdvisory {
  readonly code: KnowledgeAdvisoryCode;
  /** The entry / boundary rule / policy the advisory is about. */
  readonly subjectId: string;
  readonly assetKind: ReferenceAssetKind;
  readonly message: string;
  /** A reference that would verify the claim, ready to paste into `references[]`. */
  readonly suggestion?: IAssetReference;
}
