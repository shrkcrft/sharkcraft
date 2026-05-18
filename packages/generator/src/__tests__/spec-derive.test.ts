import { describe, expect, test } from 'bun:test';
import { deriveSpecJson } from '../spec/spec-derive.ts';
import { splitSpecMd } from '../spec/spec-frontmatter.ts';
import { SPEC_SCHEMA_V1, SpecStatus } from '../spec/spec-model.ts';

const SAMPLE_MD = `---
schema: sharkcraft.spec/v1
id: 2026-05-17-demo-spec
slug: demo-spec
title: Demo spec
status: draft
createdAt: 2026-05-17T08:00:00.000Z
updatedAt: 2026-05-17T08:00:00.000Z

intent: |
  Add a deterministic spec verb to shrk.

motivation: |
  Specs ground feature work.

acceptanceCriteria:
  - id: ac-1
    text: shrk spec create writes a file under .sharkcraft/specs/.
    verifiedBy:
      - tests

affectedAreas:
  files:
  packages:
    - packages/cli
  layers:

relevantRules:
  - repo.generation.dry-run-by-default

relevantKnowledge:

relevantPaths:
  - engine.packages

proposedTemplates:
  - templateId: engine.cli-command
    variables:
      name: spec

risks:
  - id: r-1
    text: Specs grow too long.
    mitigation: Hard-cap body bytes.

outOfScope:
  - LLM-assisted spec drafting

externalLinks:
  issue: null
  pr: null

boundariesCheck:
  predicted:

verificationCommands:
  - id: typecheck
  - id: unit-tests
---

# Demo spec
Body text.
`;

describe('deriveSpecJson', () => {
  test('produces a stable canonical view', () => {
    const split = splitSpecMd(SAMPLE_MD);
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    const derived = deriveSpecJson(split.value);
    expect(derived.ok).toBe(true);
    if (!derived.ok) return;
    const spec = derived.value;
    expect(spec.schema).toBe(SPEC_SCHEMA_V1);
    expect(spec.id).toBe('2026-05-17-demo-spec');
    expect(spec.slug).toBe('demo-spec');
    expect(spec.title).toBe('Demo spec');
    expect(spec.status).toBe(SpecStatus.Draft);
    expect(spec.intent.startsWith('Add a deterministic')).toBe(true);
    expect(spec.acceptanceCriteria).toHaveLength(1);
    expect(spec.acceptanceCriteria[0]!.verifiedBy).toEqual(['tests']);
    expect(spec.relevantRules).toEqual(['repo.generation.dry-run-by-default']);
    expect(spec.proposedTemplates[0]!.templateId).toBe('engine.cli-command');
    expect(spec.proposedTemplates[0]!.variables['name']).toBe('spec');
    expect(spec.verificationCommands.map((v) => v.id)).toEqual(['typecheck', 'unit-tests']);
    expect(spec.unknownKeys).toEqual([]);
  });

  test('hashes are deterministic across identical input', () => {
    const a = deriveOrThrow();
    const b = deriveOrThrow();
    expect(a.frontmatterHash).toBe(b.frontmatterHash);
    expect(a.bodyHash).toBe(b.bodyHash);
  });

  test('unknown frontmatter keys surface in unknownKeys', () => {
    const md = SAMPLE_MD.replace('---\nschema:', '---\nfooBar: 1\nschema:');
    const split = splitSpecMd(md);
    if (!split.ok) throw split.error;
    const derived = deriveSpecJson(split.value);
    if (!derived.ok) throw derived.error;
    expect(derived.value.unknownKeys).toEqual(['fooBar']);
  });
});

function deriveOrThrow() {
  const split = splitSpecMd(SAMPLE_MD);
  if (!split.ok) throw split.error;
  const derived = deriveSpecJson(split.value);
  if (!derived.ok) throw derived.error;
  return derived.value;
}
