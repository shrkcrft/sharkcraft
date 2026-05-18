/**
 * Shared validation pipeline tests.
 *
 * `validateExtractedPlan` is the single cross-registry checker used
 * by both `spec review` and `plan check`. These tests pin
 * down the verdict ladder against synthetic inspections.
 */
import { describe, expect, test } from 'bun:test';
import { EXTRACTED_PLAN_SCHEMA, type IExtractedPlan } from '@shrkcrft/generator';
import { validateExtractedPlan } from '../grounding/validate-extracted-plan.ts';
import type { ISharkcraftInspection } from '../sharkcraft-inspector.ts';

function makeInspection(overrides: Partial<{
  ruleIds: string[];
  knowledgeIds: string[];
  pathIds: string[];
  templateIds: string[];
  verificationCommands: Array<{ id: string; trusted?: boolean }>;
  knowledgeEntries: Array<{ id: string; scope?: string[] }>;
}> = {}): ISharkcraftInspection {
  const ruleIds = overrides.ruleIds ?? [];
  const knowledgeIds = overrides.knowledgeIds ?? [];
  const pathIds = overrides.pathIds ?? [];
  const templateIds = overrides.templateIds ?? [];
  const verificationCommands = overrides.verificationCommands ?? [];
  const knowledgeEntries = overrides.knowledgeEntries ?? knowledgeIds.map((id) => ({ id, scope: [] }));
  return {
    ruleService: { list: () => ruleIds.map((id) => ({ id })) },
    pathService: { list: () => pathIds.map((id) => ({ id })) },
    templates: templateIds.map((id) => ({ id })),
    knowledgeEntries,
    config: { verificationCommands },
  } as unknown as ISharkcraftInspection;
}

function plan(overrides: Partial<IExtractedPlan>): IExtractedPlan {
  return {
    schema: EXTRACTED_PLAN_SCHEMA,
    source: 'test',
    extractorId: 'test',
    raw: {},
    ...overrides,
  };
}

describe('validateExtractedPlan', () => {
  test('returns no errors when the plan references nothing', () => {
    const result = validateExtractedPlan(plan({}), makeInspection());
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test('flags unknown rule / knowledge / path / template / verification ids', () => {
    const result = validateExtractedPlan(
      plan({
        relevantRules: ['known', 'unknown'],
        relevantKnowledge: ['unknown-k'],
        relevantPaths: ['unknown-p'],
        proposedTemplates: [{ templateId: 'unknown-t' }],
        verificationCommandIds: ['unknown-v'],
      }),
      makeInspection({ ruleIds: ['known'] }),
    );
    const codes = result.errors.map((e) => e.code);
    expect(codes).toContain('unknown-rule-id');
    expect(codes).toContain('unknown-knowledge-id');
    expect(codes).toContain('unknown-path-id');
    expect(codes).toContain('unknown-template-id');
    expect(codes).toContain('unknown-verification-command');
  });

  test('warns when a verification command is declared but untrusted', () => {
    const result = validateExtractedPlan(
      plan({ verificationCommandIds: ['shady'] }),
      makeInspection({ verificationCommands: [{ id: 'shady', trusted: false }] }),
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings.map((w) => w.code)).toContain('untrusted-verification-command');
  });

  test('warns when ACs declare verifiedBy:[tests] but no test-shaped command is configured', () => {
    const result = validateExtractedPlan(
      plan({
        acceptanceCriteria: [{ id: 'ac-1', text: 'foo', verifiedBy: ['tests'] }],
        verificationCommandIds: ['typecheck'],
      }),
      makeInspection({ verificationCommands: [{ id: 'typecheck', trusted: true }] }),
    );
    expect(result.warnings.map((w) => w.code)).toContain('acceptance-tests-without-test-command');
  });

  test('does NOT warn when a test-shaped verification command exists', () => {
    const result = validateExtractedPlan(
      plan({
        acceptanceCriteria: [{ id: 'ac-1', text: 'foo', verifiedBy: ['tests'] }],
        verificationCommandIds: ['unit-tests'],
      }),
      makeInspection({ verificationCommands: [{ id: 'unit-tests', trusted: true }] }),
    );
    expect(result.warnings.map((w) => w.code)).not.toContain('acceptance-tests-without-test-command');
  });

  test('warns on affected packages with no matching knowledge scope', () => {
    const result = validateExtractedPlan(
      plan({ affectedPackages: ['packages/orphan'] }),
      makeInspection({
        knowledgeEntries: [{ id: 'k1', scope: ['something-else'] }],
      }),
    );
    expect(result.warnings.map((w) => w.code)).toContain('package-without-knowledge');
  });

  test('handles plans with absent optional fields without crashing', () => {
    const result = validateExtractedPlan(plan({ intent: 'do thing' }), makeInspection());
    expect(result.errors).toEqual([]);
  });
});
