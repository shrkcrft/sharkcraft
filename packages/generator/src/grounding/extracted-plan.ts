/**
 * Extractor-derived view of an external plan / spec.
 *
 * Any plan format (`sharkcraft.spec/v1`, a team's loose
 * frontmatter, etc.) reduces to this shape so the shared validation
 * pipeline in `@shrkcrft/inspector` can check it against the live
 * workspace.
 *
 * Every field is optional. Extractors populate what they can read
 * from the source; the validator reports gaps as warnings.
 */

export const EXTRACTED_PLAN_SCHEMA = 'sharkcraft.extracted-plan/v1';

export interface IExtractedAcceptanceCriterion {
  readonly id?: string;
  readonly text: string;
  readonly verifiedBy?: readonly string[];
}

export interface IExtractedProposedTemplate {
  readonly templateId: string;
  readonly variables?: Readonly<Record<string, string>>;
}

export interface IExtractedPlan {
  readonly schema: typeof EXTRACTED_PLAN_SCHEMA;
  /** Source path (relative or absolute). May be empty when the plan was passed inline. */
  readonly source: string;
  /** Which extractor produced this view. */
  readonly extractorId: string;
  readonly intent?: string;
  readonly motivation?: string;
  readonly title?: string;
  readonly affectedFiles?: readonly string[];
  readonly affectedPackages?: readonly string[];
  readonly acceptanceCriteria?: readonly IExtractedAcceptanceCriterion[];
  readonly relevantRules?: readonly string[];
  readonly relevantKnowledge?: readonly string[];
  readonly relevantPaths?: readonly string[];
  readonly proposedTemplates?: readonly IExtractedProposedTemplate[];
  readonly verificationCommandIds?: readonly string[];
  /** Original parsed structure (extractor-specific), for traceability. */
  readonly raw: unknown;
}
