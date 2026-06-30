import { describe, expect, test } from 'bun:test';
import { defineKnowledgeEntry, KnowledgePriority, KnowledgeType } from '@shrkcrft/knowledge';
import { buildContext } from '../context-builder.ts';

describe('buildContext — orphan types reach the agent by default', () => {
  test('a Decision whose appliesWhen matches is included without --include-docs', () => {
    const entries = [
      defineKnowledgeEntry({
        id: 'decision.layering',
        title: 'Strict layer order',
        type: KnowledgeType.Decision,
        priority: KnowledgePriority.High,
        scope: ['architecture'],
        appliesWhen: ['generate-code'],
        content: 'Lower layers never import higher ones.',
      }),
    ];
    const result = buildContext(entries, { task: 'generate code', maxTokens: 4000 });
    const ids = result.sections.flatMap((s) => s.entryIds);
    expect(ids).toContain('decision.layering');
    const decisionSection = result.sections.find((s) => s.title === 'Architecture Decisions');
    expect(decisionSection?.entryIds).toContain('decision.layering');
  });
});

describe('buildContext — priority-aware pruning', () => {
  test('a tight budget truncates the highest-priority section rather than dropping it for a lower one', () => {
    const entries = [
      defineKnowledgeEntry({
        id: 'warn.big',
        title: 'Critical safety warning',
        type: KnowledgeType.Warning,
        priority: KnowledgePriority.Critical,
        scope: ['demo'],
        appliesWhen: ['generate-code'],
        content: 'danger '.repeat(500), // large body — will not fit whole
      }),
      defineKnowledgeEntry({
        id: 'tech.small',
        title: 'Stack',
        type: KnowledgeType.Technical,
        priority: KnowledgePriority.Low,
        scope: ['demo'],
        appliesWhen: ['generate-code'],
        content: 'tiny',
      }),
    ];
    // Budget admits the tiny overview, then the big high-priority warning must
    // degrade by truncation — NOT vanish while the small low-priority section is
    // kept (the pre-fix behavior).
    const result = buildContext(entries, {
      task: 'generate code',
      scope: ['demo'],
      maxTokens: 30,
      projectOverview: 'demo',
    });
    const titles = result.sections.map((s) => s.title);
    expect(titles).toContain('Important Warnings');
    const warning = result.sections.find((s) => s.title === 'Important Warnings');
    expect(warning?.truncated).toBe(true);
    // The lower-priority section is dropped instead of the critical one.
    expect(titles).not.toContain('Technical Stack');
    expect(result.omittedSections).toContain('Technical Stack');
  });
});
