/**
 * Extractor tests.
 *
 * Two built-in extractors: `sharkcraft.spec/v1` (wraps ) and
 * `markdown-frontmatter-loose` (any YAML frontmatter, with optional
 * field-map remapping).
 */
import { describe, expect, test } from 'bun:test';
import {
  EXTRACTED_PLAN_SCHEMA,
  MARKDOWN_FRONTMATTER_LOOSE_EXTRACTOR_ID,
  SHARKCRAFT_SPEC_V1_EXTRACTOR_ID,
  getExtractorById,
  markdownFrontmatterLooseExtractor,
  pickExtractor,
  sharkcraftSpecV1Extractor,
} from '../grounding/index.ts';

const R57_SPEC = `---
schema: sharkcraft.spec/v1
id: 2026-05-17-demo
slug: demo
title: Demo
status: draft
createdAt: 2026-05-17T00:00:00.000Z
updatedAt: 2026-05-17T00:00:00.000Z

intent: |
  Test extractor.

motivation: |
  Verify.

acceptanceCriteria:
  - id: ac-1
    text: Extractor returns IExtractedPlan.
    verifiedBy: [tests]

affectedAreas:
  files:
    - apps/api/src/billing.ts
  packages:
    - apps/api
  layers:

relevantRules:
  - repo.safety.mcp-is-read-only

relevantKnowledge:
relevantPaths:
  - engine.packages

proposedTemplates:
  - templateId: engine.cli-command
    variables:
      name: demo

risks:
outOfScope:
externalLinks:
  issue: null
  pr: null
boundariesCheck:
  predicted:

verificationCommands:
  - id: typecheck
  - id: unit-tests
---

body
`;

const LOOSE_PLAN = `---
title: Add billing module
intent: Wire NestJS billing endpoint to Lambda.
affectedFiles:
  - apps/api/src/billing.controller.ts
  - apps/lambda/src/handler.ts
acceptanceCriteria:
  - id: ac-1
    text: POST /billing returns 200
    verifiedBy: [tests]
verificationCommandIds: [typecheck]
relevantRules: [repo.safety.mcp-is-read-only]
---

Body.
`;

const LOOSE_WITH_FIELD_MAP = `---
title: Add billing module
files_changed:
  - apps/api/src/billing.controller.ts
verify_with: [typecheck]
---

Body.
`;

describe('sharkcraft.spec/v1 extractor', () => {
  test('extracts the spec view', () => {
    const r = sharkcraftSpecV1Extractor.extract(R57_SPEC, { source: 'spec.md' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.schema).toBe(EXTRACTED_PLAN_SCHEMA);
    expect(r.value.extractorId).toBe(SHARKCRAFT_SPEC_V1_EXTRACTOR_ID);
    expect(r.value.intent).toContain('Test extractor');
    expect(r.value.relevantRules).toEqual(['repo.safety.mcp-is-read-only']);
    expect(r.value.proposedTemplates).toEqual([
      { templateId: 'engine.cli-command', variables: { name: 'demo' } },
    ]);
    expect(r.value.verificationCommandIds).toEqual(['typecheck', 'unit-tests']);
    expect(r.value.affectedFiles).toEqual(['apps/api/src/billing.ts']);
  });

  test('accepts paths ending in spec.md only', () => {
    expect(sharkcraftSpecV1Extractor.accepts('foo/spec.md')).toBe(true);
    expect(sharkcraftSpecV1Extractor.accepts('foo/feature.md')).toBe(false);
  });
});

describe('markdown-frontmatter-loose extractor', () => {
  test('extracts plan from any YAML frontmatter', () => {
    const r = markdownFrontmatterLooseExtractor.extract(LOOSE_PLAN, { source: 'plan.md' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.extractorId).toBe(MARKDOWN_FRONTMATTER_LOOSE_EXTRACTOR_ID);
    expect(r.value.title).toBe('Add billing module');
    expect(r.value.affectedFiles).toEqual([
      'apps/api/src/billing.controller.ts',
      'apps/lambda/src/handler.ts',
    ]);
    expect(r.value.acceptanceCriteria).toHaveLength(1);
    expect(r.value.verificationCommandIds).toEqual(['typecheck']);
  });

  test('field-map remaps external keys to canonical keys', () => {
    const r = markdownFrontmatterLooseExtractor.extract(LOOSE_WITH_FIELD_MAP, {
      source: 'team-plan.md',
      fieldMap: {
        files_changed: 'affectedFiles',
        verify_with: 'verificationCommandIds',
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.affectedFiles).toEqual(['apps/api/src/billing.controller.ts']);
    expect(r.value.verificationCommandIds).toEqual(['typecheck']);
  });

  test('refuses files without frontmatter', () => {
    const r = markdownFrontmatterLooseExtractor.extract('# Just markdown\n\nNo frontmatter.\n', {
      source: 'noheader.md',
    });
    expect(r.ok).toBe(false);
  });

  test('accepts .md and .mdx extensions', () => {
    expect(markdownFrontmatterLooseExtractor.accepts('foo.md')).toBe(true);
    expect(markdownFrontmatterLooseExtractor.accepts('foo.mdx')).toBe(true);
    expect(markdownFrontmatterLooseExtractor.accepts('foo.txt')).toBe(false);
  });
});

describe('extractor registry', () => {
  test('getExtractorById returns the right extractor', () => {
    expect(getExtractorById(SHARKCRAFT_SPEC_V1_EXTRACTOR_ID)?.id).toBe(SHARKCRAFT_SPEC_V1_EXTRACTOR_ID);
    expect(getExtractorById(MARKDOWN_FRONTMATTER_LOOSE_EXTRACTOR_ID)?.id).toBe(MARKDOWN_FRONTMATTER_LOOSE_EXTRACTOR_ID);
    expect(getExtractorById('unknown')).toBeNull();
  });

  test('pickExtractor prefers sharkcraft.spec/v1 for spec.md paths', () => {
    expect(pickExtractor('foo/spec.md')?.id).toBe(SHARKCRAFT_SPEC_V1_EXTRACTOR_ID);
  });

  test('pickExtractor falls back to markdown-frontmatter-loose for other markdown', () => {
    expect(pickExtractor('plans/feature.md')?.id).toBe(MARKDOWN_FRONTMATTER_LOOSE_EXTRACTOR_ID);
  });

  test('pickExtractor returns null for non-markdown', () => {
    expect(pickExtractor('plans/plan.json')).toBeNull();
  });
});
