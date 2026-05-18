/**
 * template-authoring builder.
 *
 * Locks in the contract for `buildTemplateAuthoringPreview`:
 *   - update produces a TS draft with the merged metadata.
 *   - update refuses unknown ids.
 *   - remove refuses when reverse-references exist.
 *   - remove succeeds when forcePreview is set.
 *   - reverse-reference detection covers pipelines, presets, knowledge.
 */
import { describe, expect, test } from 'bun:test';
import {
  buildTemplateAuthoringPreview,
  TemplateAuthoringOperation,
} from '../template-authoring.ts';

const baseTemplate = {
  id: 'team.service',
  name: 'Service scaffold',
  description: 'Scaffolds a service.',
  tags: ['backend'],
  scope: ['backend'],
  appliesWhen: ['create-feature'],
  variables: [],
  files: () => [],
  related: [],
  postGenerationNotes: [],
  metadata: { requiredProfileIds: ['core'] },
} as unknown as Parameters<typeof buildTemplateAuthoringPreview>[1]['templates'][number];

describe('buildTemplateAuthoringPreview', () => {
  test('update produces a TS draft with merged tags', () => {
    const result = buildTemplateAuthoringPreview(
      {
        operation: TemplateAuthoringOperation.Update,
        id: 'team.service',
        updateOps: { addTags: ['r52'], setDescription: 'New description' },
      },
      { templates: [baseTemplate] },
    );
    expect(result.ok).toBe(true);
    expect(result.tsDraft.body).toContain('"backend"');
    expect(result.tsDraft.body).toContain('"r52"');
    expect(result.tsDraft.body).toContain('New description');
    expect(result.patch?.changes.length).toBeGreaterThan(0);
  });

  test('update refuses unknown id', () => {
    const result = buildTemplateAuthoringPreview(
      {
        operation: TemplateAuthoringOperation.Update,
        id: 'team.missing',
        updateOps: { setName: 'X' },
      },
      { templates: [baseTemplate] },
    );
    expect(result.ok).toBe(false);
    expect(result.refusal).toMatch(/does not exist|exists\./);
  });

  test('remove refuses when pipeline references the template', () => {
    const pipeline = {
      id: 'team.feature-dev',
      name: 'Feature dev',
      steps: [
        { id: 'step-a', type: 'context', references: ['team.service'] },
      ],
    } as unknown as NonNullable<Parameters<typeof buildTemplateAuthoringPreview>[1]['pipelines']>[number];
    const result = buildTemplateAuthoringPreview(
      { operation: TemplateAuthoringOperation.Remove, id: 'team.service' },
      { templates: [baseTemplate], pipelines: [pipeline] },
    );
    expect(result.ok).toBe(false);
    expect(result.reverseReferences?.[0]?.fromKind).toBe('pipeline');
    expect(result.reverseReferences?.[0]?.fromId).toBe('team.feature-dev');
  });

  test('remove refuses when knowledge entry references the template', () => {
    const knowledge = {
      id: 'team.note',
      title: 'Note',
      type: 'documentation',
      priority: 'medium',
      scope: [],
      tags: [],
      appliesWhen: [],
      content: 'See the service scaffold.',
      references: [{ kind: 'template', id: 'team.service' }],
    } as unknown as NonNullable<Parameters<typeof buildTemplateAuthoringPreview>[1]['knowledgeEntries']>[number];
    const result = buildTemplateAuthoringPreview(
      { operation: TemplateAuthoringOperation.Remove, id: 'team.service' },
      { templates: [baseTemplate], knowledgeEntries: [knowledge] },
    );
    expect(result.ok).toBe(false);
    expect(result.reverseReferences?.[0]?.fromKind).toBe('knowledge');
  });

  test('remove succeeds with forcePreview=true even when references exist', () => {
    const pipeline = {
      id: 'team.feature-dev',
      name: 'Feature dev',
      steps: [
        { id: 'step-a', type: 'context', references: ['team.service'] },
      ],
    } as unknown as NonNullable<Parameters<typeof buildTemplateAuthoringPreview>[1]['pipelines']>[number];
    const result = buildTemplateAuthoringPreview(
      {
        operation: TemplateAuthoringOperation.Remove,
        id: 'team.service',
        forcePreview: true,
      },
      { templates: [baseTemplate], pipelines: [pipeline] },
    );
    expect(result.ok).toBe(true);
    expect(result.reverseReferences?.length ?? 0).toBeGreaterThan(0);
  });

  test('remove on a template with no references succeeds without --force-preview', () => {
    const result = buildTemplateAuthoringPreview(
      { operation: TemplateAuthoringOperation.Remove, id: 'team.service' },
      { templates: [baseTemplate] },
    );
    expect(result.ok).toBe(true);
    expect(result.explainer.body).toContain('Template removal preview');
  });
});
