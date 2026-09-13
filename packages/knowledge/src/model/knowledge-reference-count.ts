import type { IAssetReferenceCount } from '@shrkcrft/core';

/**
 * A count a knowledge reference claims (`references[].count`).
 *
 * The shape is core's {@link IAssetReferenceCount}: boundary rules and policy
 * checks declare the same references, so the count is defined once, below every
 * package that reads it. It is evaluated by the one extraction authority
 * (`inspectSource`), never a second parser.
 */
export type IKnowledgeReferenceCount = IAssetReferenceCount;
