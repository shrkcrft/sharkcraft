/**
 * Shared cross-registry validation for an `IExtractedPlan`.
 *
 * Both `shrk spec review` and `shrk plan check` go through this
 * single pipeline. `spec review` extracts via the
 * `sharkcraft.spec/v1` extractor; `plan check` accepts any extractor
 * that produces the canonical view.
 *
 * Every field is optional — extractors populate what they can read.
 * The validator only checks what's present; absent fields do not
 * produce errors.
 */

import type { IExtractedPlan, ISpecValidationIssue } from '@shrkcrft/generator';
import type { ISharkcraftInspection } from '../sharkcraft-inspector.ts';

export interface IExtractedPlanValidation {
  readonly errors: readonly ISpecValidationIssue[];
  readonly warnings: readonly ISpecValidationIssue[];
}

export function validateExtractedPlan(
  plan: IExtractedPlan,
  inspection: ISharkcraftInspection,
): IExtractedPlanValidation {
  const errors: ISpecValidationIssue[] = [];
  const warnings: ISpecValidationIssue[] = [];

  const ruleIds = new Set(inspection.ruleService.list().map((r) => r.id));
  const knowledgeIds = new Set(inspection.knowledgeEntries.map((k) => k.id));
  const pathIds = new Set(inspection.pathService.list().map((p) => p.id));
  const templateIds = new Set(inspection.templates.map((t) => t.id));
  const trustedCommandIds = new Set(
    (inspection.config?.verificationCommands ?? [])
      .filter((c) => c.trusted !== false)
      .map((c) => c.id),
  );
  const allCommandIds = new Set((inspection.config?.verificationCommands ?? []).map((c) => c.id));

  const rules = plan.relevantRules ?? [];
  for (let i = 0; i < rules.length; i++) {
    const id = rules[i]!;
    if (!ruleIds.has(id)) {
      errors.push({
        code: 'unknown-rule-id',
        severity: 'error',
        field: `relevantRules[${i}]`,
        message: `Unknown rule id "${id}"`,
      });
    }
  }
  const knowledge = plan.relevantKnowledge ?? [];
  for (let i = 0; i < knowledge.length; i++) {
    const id = knowledge[i]!;
    if (!knowledgeIds.has(id)) {
      errors.push({
        code: 'unknown-knowledge-id',
        severity: 'error',
        field: `relevantKnowledge[${i}]`,
        message: `Unknown knowledge id "${id}"`,
      });
    }
  }
  const paths = plan.relevantPaths ?? [];
  for (let i = 0; i < paths.length; i++) {
    const id = paths[i]!;
    if (!pathIds.has(id)) {
      errors.push({
        code: 'unknown-path-id',
        severity: 'error',
        field: `relevantPaths[${i}]`,
        message: `Unknown path id "${id}"`,
      });
    }
  }
  const templates = plan.proposedTemplates ?? [];
  for (let i = 0; i < templates.length; i++) {
    const t = templates[i]!;
    if (!templateIds.has(t.templateId)) {
      errors.push({
        code: 'unknown-template-id',
        severity: 'error',
        field: `proposedTemplates[${i}].templateId`,
        message: `Unknown template id "${t.templateId}"`,
      });
    }
  }
  const verificationIds = plan.verificationCommandIds ?? [];
  for (let i = 0; i < verificationIds.length; i++) {
    const id = verificationIds[i]!;
    if (!allCommandIds.has(id)) {
      errors.push({
        code: 'unknown-verification-command',
        severity: 'error',
        field: `verificationCommandIds[${i}]`,
        message: `Unknown verification command "${id}" — declare it in sharkcraft.config.ts verificationCommands[]`,
      });
    } else if (!trustedCommandIds.has(id)) {
      warnings.push({
        code: 'untrusted-verification-command',
        severity: 'warning',
        field: `verificationCommandIds[${i}]`,
        message: `Verification command "${id}" is declared but not marked trusted — \`spec verify\` will refuse to run it`,
      });
    }
  }

  // Coverage heuristic — only fires when both AC + verification info are present.
  const acceptance = plan.acceptanceCriteria ?? [];
  if (acceptance.length > 0 && verificationIds.length > 0) {
    const haveTestCommand = verificationIds.some((id) =>
      /test|spec|jest|bun-test|unit|integration|e2e/i.test(id),
    );
    if (!haveTestCommand) {
      for (let i = 0; i < acceptance.length; i++) {
        const ac = acceptance[i]!;
        if (ac.verifiedBy?.includes('tests')) {
          warnings.push({
            code: 'acceptance-tests-without-test-command',
            severity: 'warning',
            field: `acceptanceCriteria[${i}].verifiedBy`,
            message: `Acceptance criterion "${ac.id ?? `#${i}`}" is verified by tests but the plan declares no test-shaped verification command`,
          });
          break;
        }
      }
    }
  }

  // Missing-knowledge heuristic — only fires when the workspace has knowledge entries.
  const affectedPackages = plan.affectedPackages ?? [];
  if (affectedPackages.length > 0 && inspection.knowledgeEntries.length > 0) {
    for (const pkg of affectedPackages) {
      const hit = inspection.knowledgeEntries.some(
        (k) => (k as { scope?: readonly string[] }).scope?.some((s) => pkg.includes(s)) ?? false,
      );
      if (!hit) {
        warnings.push({
          code: 'package-without-knowledge',
          severity: 'warning',
          field: 'affectedPackages',
          message: `Package "${pkg}" has no knowledge entry — consider authoring one alongside the plan`,
        });
      }
    }
  }

  return { errors, warnings };
}
