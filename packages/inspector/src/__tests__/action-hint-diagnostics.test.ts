import { describe, expect, test } from 'bun:test';
import {
  defineKnowledgeEntry,
  KnowledgePriority,
  KnowledgeType,
} from '@shrkcrft/knowledge';
import { diagnoseActionHints } from '../action-hint-diagnostics.ts';

describe('diagnoseActionHints', () => {
  test('flags critical/high generation rule with no hints', () => {
    const e = defineKnowledgeEntry({
      id: 'demo.rule',
      title: 'Demo rule',
      type: KnowledgeType.Rule,
      priority: KnowledgePriority.Critical,
      appliesWhen: ['generate-code'],
      content: 'x',
    });
    const r = diagnoseActionHints([e]);
    expect(r.evaluatedEntryCount).toBe(1);
    expect(r.issues.some((i) => i.code === 'missing-hints')).toBe(true);
  });

  test('skips path entries (they describe location, not action)', () => {
    const e = defineKnowledgeEntry({
      id: 'demo.path',
      title: 'Demo path',
      type: KnowledgeType.Path,
      priority: KnowledgePriority.High,
      appliesWhen: ['generate-utility'],
      content: 'x',
    });
    const r = diagnoseActionHints([e]);
    expect(r.evaluatedEntryCount).toBe(0);
    expect(r.issues.length).toBe(0);
  });

  test('does not flag medium priority entries', () => {
    const e = defineKnowledgeEntry({
      id: 'demo.medium',
      title: 'Medium rule',
      type: KnowledgeType.Rule,
      priority: KnowledgePriority.Medium,
      appliesWhen: ['generate-code'],
      content: 'x',
    });
    const r = diagnoseActionHints([e]);
    expect(r.evaluatedEntryCount).toBe(0);
  });

  test('passes when rule has commands + forbiddenActions + verification', () => {
    const e = defineKnowledgeEntry({
      id: 'demo.complete',
      title: 'Complete rule',
      type: KnowledgeType.Rule,
      priority: KnowledgePriority.Critical,
      appliesWhen: ['generate-code'],
      content: 'x',
      actionHints: {
        commands: [{ command: 'shrk doctor' }],
        forbiddenActions: ['never...'],
        verificationCommands: ['bun test'],
        writePolicy: 'cli-only',
      },
    });
    const r = diagnoseActionHints([e]);
    expect(r.issues.length).toBe(0);
  });

  test('flags missing-write-policy on safety-tagged rules without writePolicy', () => {
    const e = defineKnowledgeEntry({
      id: 'demo.unsafe',
      title: 'Unsafe',
      type: KnowledgeType.Rule,
      priority: KnowledgePriority.Critical,
      tags: ['safety'],
      appliesWhen: ['generate-code'],
      content: 'x',
      actionHints: {
        commands: [{ command: 'shrk gen x y' }],
        forbiddenActions: ['x'],
        verificationCommands: ['bun test'],
      },
    });
    const r = diagnoseActionHints([e]);
    expect(r.issues.some((i) => i.code === 'missing-write-policy')).toBe(true);
  });
});
