import { describe, expect, test } from 'bun:test';
import {
  hasActionHints,
  hasMeaningfulActionHints,
  isPlaceholderCommand,
  type IActionHints,
} from '../model/action-hints.ts';
import { defineKnowledgeEntry } from '../define/define-knowledge-entry.ts';
import { KNOWLEDGE_TYPES_NO_ACTION, KnowledgeType } from '../model/knowledge-type.ts';

describe('isPlaceholderCommand', () => {
  test('treats bare placeholders / empties as placeholders', () => {
    expect(isPlaceholderCommand('<command>')).toBe(true);
    expect(isPlaceholderCommand('<task>')).toBe(true);
    expect(isPlaceholderCommand('   ')).toBe(true);
    expect(isPlaceholderCommand('')).toBe(true);
  });

  test('a parameterized command with concrete tokens is NOT a placeholder', () => {
    expect(isPlaceholderCommand('shrk gen <template> <name>')).toBe(false);
    expect(isPlaceholderCommand('bun test')).toBe(false);
    expect(isPlaceholderCommand('shrk doctor')).toBe(false);
  });
});

describe('hasMeaningfulActionHints', () => {
  const wrap = (actionHints: IActionHints) => ({ actionHints });

  test('rejects presence-only / hollow hints an agent adds to game the gate', () => {
    expect(hasMeaningfulActionHints({})).toBe(false);
    expect(hasMeaningfulActionHints(wrap({}))).toBe(false);
    expect(hasMeaningfulActionHints(wrap({ requiresHumanReview: true }))).toBe(false);
    expect(hasMeaningfulActionHints(wrap({ writePolicy: 'cli-only' }))).toBe(false);
    // A lone placeholder command does not count.
    expect(hasMeaningfulActionHints(wrap({ commands: [{ command: '<command>' }] }))).toBe(false);
    // Cross-references alone are NOT meaningful here (value depends on resolution).
    expect(hasMeaningfulActionHints(wrap({ relatedKnowledge: ['x'] }))).toBe(false);
  });

  test('accepts substantive, actionable guidance', () => {
    expect(hasMeaningfulActionHints(wrap({ commands: [{ command: 'shrk doctor' }] }))).toBe(true);
    expect(hasMeaningfulActionHints(wrap({ mcpTools: [{ tool: 'get_relevant_context' }] }))).toBe(true);
    expect(hasMeaningfulActionHints(wrap({ verificationCommands: ['bun test'] }))).toBe(true);
    expect(hasMeaningfulActionHints(wrap({ preferredFlow: ['step-a'] }))).toBe(true);
    expect(hasMeaningfulActionHints(wrap({ forbiddenActions: ['do not write to MCP'] }))).toBe(true);
  });

  test('is strictly stronger than presence-only hasActionHints', () => {
    // A hint that passes the OLD presence gate but fails the quality gate.
    const hollow = wrap({ requiresHumanReview: true });
    expect(hasActionHints(hollow)).toBe(true);
    expect(hasMeaningfulActionHints(hollow)).toBe(false);
  });
});

describe('noAction opt-out', () => {
  test('defineKnowledgeEntry round-trips the author-set noAction flag', () => {
    const entry = defineKnowledgeEntry({
      id: 'arch.thesis',
      title: 'Layering thesis',
      type: KnowledgeType.Architecture,
      content: 'Context only.',
      noAction: true,
    });
    expect(entry.noAction).toBe(true);
    // Absent by default (so it doesn't pollute entries that never set it).
    const plain = defineKnowledgeEntry({
      id: 'r.plain',
      title: 'Plain',
      type: KnowledgeType.Rule,
      content: 'x',
    });
    expect(plain.noAction).toBeUndefined();
  });
});

describe('KNOWLEDGE_TYPES_NO_ACTION', () => {
  test('exempts purely-descriptive types only', () => {
    expect(KNOWLEDGE_TYPES_NO_ACTION.has(KnowledgeType.Business)).toBe(true);
    expect(KNOWLEDGE_TYPES_NO_ACTION.has(KnowledgeType.Decision)).toBe(true);
    // Actionable types stay in the denominator.
    expect(KNOWLEDGE_TYPES_NO_ACTION.has(KnowledgeType.Rule)).toBe(false);
    expect(KNOWLEDGE_TYPES_NO_ACTION.has(KnowledgeType.Workflow)).toBe(false);
    expect(KNOWLEDGE_TYPES_NO_ACTION.has(KnowledgeType.Command)).toBe(false);
  });
});
