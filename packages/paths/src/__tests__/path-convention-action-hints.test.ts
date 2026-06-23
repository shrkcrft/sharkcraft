import { describe, expect, test } from 'bun:test';
import { hasActionHints } from '@shrkcrft/knowledge';
import { definePathConvention } from '../path-convention.ts';

/**
 * Locks the contract that path entries CAN carry actionHints. The factory
 * input is `Omit<DefineKnowledgeInput, 'type' | 'content'>`, which keeps
 * `actionHints`, and the `{ ...input }` spread forwards it to
 * defineKnowledgeEntry. This test fails if anyone ever adds `actionHints` to
 * that Omit<> or stops forwarding it — i.e. it guards against the path factory
 * silently dropping action hints.
 */
describe('definePathConvention actionHints pass-through', () => {
  test('forwards actionHints onto the returned path convention', () => {
    const p = definePathConvention({
      id: 'engine.packages',
      title: 'Engine packages',
      path: 'packages',
      priority: 'critical',
      appliesWhen: ['generate-code'],
      actionHints: {
        mcpTools: [{ tool: 'check_boundaries' }],
        relatedKnowledge: ['repo.architecture.respect-layer-order'],
      },
    });
    expect(p.actionHints?.mcpTools?.[0]?.tool).toBe('check_boundaries');
    expect(p.actionHints?.relatedKnowledge).toContain('repo.architecture.respect-layer-order');
    expect(hasActionHints(p)).toBe(true);
  });

  test('a path convention without actionHints is valid and reports none', () => {
    const p = definePathConvention({ id: 'engine.docs', title: 'Docs', path: 'docs' });
    expect(p.actionHints).toBeUndefined();
    expect(hasActionHints(p)).toBe(false);
  });
});
