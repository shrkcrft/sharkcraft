/**
 * `shrk spec review` report assembly.
 *
 * Read-only. Combines structural validation (generator-side) with
 * cross-registry validation (this package) and produces the
 * `sharkcraft.spec-review/v1` envelope.
 */

import {
  validateSpecStructural,
  type ISpecJson,
  type ISpecValidationIssue,
} from '@shrkcrft/generator';
import type { ISharkcraftInspection } from '../sharkcraft-inspector.ts';
import { validateSpecAgainstWorkspace } from './spec-cross-validate.ts';

export const SPEC_REVIEW_SCHEMA = 'sharkcraft.spec-review/v1';

export interface ISpecReviewReport {
  readonly schema: typeof SPEC_REVIEW_SCHEMA;
  readonly specId: string;
  readonly specPath: string;
  readonly frontmatterHash: string;
  readonly verdict: 'pass' | 'warn' | 'fail';
  readonly errors: readonly ISpecValidationIssue[];
  readonly warnings: readonly ISpecValidationIssue[];
  readonly info: readonly ISpecValidationIssue[];
  readonly predicted: {
    readonly boundaryRisks: readonly { from: string; to: string; reason: string }[];
  };
}

export interface IBuildSpecReviewInput {
  readonly spec: ISpecJson;
  readonly specPath: string;
  readonly body: string;
  readonly inspection: ISharkcraftInspection;
  readonly bodyMaxBytes?: number;
}

export function buildSpecReview(input: IBuildSpecReviewInput): ISpecReviewReport {
  const structural = validateSpecStructural(input.spec, input.body, {
    bodyMaxBytes: input.bodyMaxBytes,
  });
  const cross = validateSpecAgainstWorkspace(input.spec, input.inspection);
  const errors = [...structural.errors, ...cross.errors];
  const warnings = [...structural.warnings, ...cross.warnings];
  const info: ISpecValidationIssue[] = [];

  const verdict: 'pass' | 'warn' | 'fail' =
    errors.length > 0 ? 'fail' : warnings.length > 0 ? 'warn' : 'pass';

  return {
    schema: SPEC_REVIEW_SCHEMA,
    specId: input.spec.id,
    specPath: input.specPath,
    frontmatterHash: input.spec.frontmatterHash,
    verdict,
    errors,
    warnings,
    info,
    predicted: {
      boundaryRisks: input.spec.boundariesCheck.predicted.map((p) => ({
        from: p.from,
        to: p.to,
        reason: p.reason,
      })),
    },
  };
}
