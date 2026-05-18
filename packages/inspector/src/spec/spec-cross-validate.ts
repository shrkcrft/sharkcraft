/**
 * Cross-registry validation for a parsed `ISpecJson`.
 *
 * This is a thin shim that projects the spec.json view onto
 * `IExtractedPlan` and delegates to the shared validator at
 * `../grounding/validate-extracted-plan.ts`. The wire shape on the
 * spec side is preserved verbatim so callers (`buildSpecReview`,
 * the MCP `get_spec_review` tool) stay green.
 */

import {
  EXTRACTED_PLAN_SCHEMA,
  type IExtractedPlan,
  type ISpecJson,
  type ISpecValidationIssue,
} from '@shrkcrft/generator';
import type { ISharkcraftInspection } from '../sharkcraft-inspector.ts';
import { validateExtractedPlan } from '../grounding/validate-extracted-plan.ts';

export interface ISpecCrossValidation {
  readonly errors: readonly ISpecValidationIssue[];
  readonly warnings: readonly ISpecValidationIssue[];
}

export function validateSpecAgainstWorkspace(
  spec: ISpecJson,
  inspection: ISharkcraftInspection,
): ISpecCrossValidation {
  const extracted: IExtractedPlan = {
    schema: EXTRACTED_PLAN_SCHEMA,
    source: spec.id,
    extractorId: 'sharkcraft.spec/v1',
    intent: spec.intent || undefined,
    motivation: spec.motivation || undefined,
    title: spec.title || undefined,
    affectedFiles: spec.affectedAreas.files,
    affectedPackages: spec.affectedAreas.packages,
    acceptanceCriteria: spec.acceptanceCriteria.map((ac) => ({
      id: ac.id,
      text: ac.text,
      verifiedBy: ac.verifiedBy,
    })),
    relevantRules: spec.relevantRules,
    relevantKnowledge: spec.relevantKnowledge,
    relevantPaths: spec.relevantPaths,
    proposedTemplates: spec.proposedTemplates.map((t) => ({
      templateId: t.templateId,
      variables: t.variables,
    })),
    verificationCommandIds: spec.verificationCommands.map((v) => v.id),
    raw: spec,
  };
  const result = validateExtractedPlan(extracted, inspection);
  // The spec cross-validate emitted `verificationCommands[i].id` fields;
  // the hoisted validator emits `verificationCommandIds[i]`. Project
  // back so the spec wire shape is unchanged.
  return {
    errors: result.errors.map(remapVerificationField),
    warnings: result.warnings.map(remapVerificationField),
  };
}

function remapVerificationField(issue: ISpecValidationIssue): ISpecValidationIssue {
  if (!issue.field.startsWith('verificationCommandIds[')) return issue;
  return {
    ...issue,
    field: issue.field.replace(/^verificationCommandIds\[(\d+)\]$/, 'verificationCommands[$1].id'),
  };
}
