/**
 * `sharkcraft.spec/v1` extractor.
 *
 * Wraps the spec parser + derive pipeline and projects the result onto
 * the canonical `IExtractedPlan` shape. This is the high-confidence
 * path: when the team is already writing `sharkcraft.spec/v1` specs,
 * no information is lost in translation.
 */

import { AppErrorImpl, ERROR_CODES, err, ok, type AppError, type Result } from '@shrkcrft/core';
import { deriveSpecJson } from '../../spec/spec-derive.ts';
import { splitSpecMd } from '../../spec/spec-frontmatter.ts';
import { EXTRACTED_PLAN_SCHEMA, type IExtractedPlan } from '../extracted-plan.ts';
import type { IExtractorContext, IPlanExtractor } from '../extractor.ts';

export const SHARKCRAFT_SPEC_V1_EXTRACTOR_ID = 'sharkcraft.spec/v1';

export const sharkcraftSpecV1Extractor: IPlanExtractor = {
  id: SHARKCRAFT_SPEC_V1_EXTRACTOR_ID,
  description: 'sharkcraft.spec/v1 format — wraps the spec.md parser.',
  accepts(path: string): boolean {
    return path.endsWith('spec.md');
  },
  extract(raw: string, ctx: IExtractorContext): Result<IExtractedPlan, AppError> {
    const split = splitSpecMd(raw);
    if (!split.ok) return err(split.error);
    const derived = deriveSpecJson(split.value);
    if (!derived.ok) return err(derived.error);
    const spec = derived.value;
    const view: IExtractedPlan = {
      schema: EXTRACTED_PLAN_SCHEMA,
      source: ctx.source,
      extractorId: SHARKCRAFT_SPEC_V1_EXTRACTOR_ID,
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
    return ok(view);
  },
};

void AppErrorImpl;
void ERROR_CODES;
