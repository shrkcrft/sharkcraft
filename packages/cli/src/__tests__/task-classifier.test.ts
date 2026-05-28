import { describe, expect, test } from 'bun:test';
import { TaskType, classifyTask, parseTaskTypeOverride } from '@shrkcrft/embeddings';

describe('classifyTask — fixture cases', () => {
  test('the canonical architecture prompt from the user review is classified as architecture', () => {
    const res = classifyTask(
      'i want to create a process that works parallel with the claude agent and constantly serves it with a lot of information',
    );
    expect(res.type).toBe(TaskType.Architecture);
    expect(res.confidence).toBeGreaterThan(0.5);
    // Must catch the "create a process" + "in parallel with" + "constantly … serves" signals.
    const joined = res.signals.join(' ');
    expect(joined).toContain('architecture');
    expect(joined).toMatch(/create-a-process|in-parallel-with|continuous-feed/);
  });

  test('a concrete add-a-doctor-check task is implementation/scaffold, not architecture', () => {
    const res = classifyTask('add a new doctor check that surfaces stale package.json versions');
    expect(res.type).not.toBe(TaskType.Architecture);
    // Either implementation or scaffold — both acceptable.
    expect([TaskType.Implementation, TaskType.Scaffold]).toContain(res.type);
  });

  test('"fix the broken parser" → bugfix', () => {
    const res = classifyTask('fix the broken json parser that crashes on empty input');
    expect(res.type).toBe(TaskType.Bugfix);
  });

  test('"refactor X" → refactor', () => {
    const res = classifyTask('refactor the rule registry to share code with the path registry');
    expect(res.type).toBe(TaskType.Refactor);
  });

  test('"investigate why X" → investigation', () => {
    const res = classifyTask('investigate why the dashboard route loads slowly');
    expect(res.type).toBe(TaskType.Investigation);
  });

  test('"review the auth changes" → validation', () => {
    const res = classifyTask('review the auth middleware changes for safety');
    expect(res.type).toBe(TaskType.Validation);
  });

  test('a generic short task returns Generic with confidence 0', () => {
    const res = classifyTask('blah blah blah xyz');
    expect(res.type).toBe(TaskType.Generic);
    expect(res.confidence).toBe(0);
  });

  test('architecture beats implementation when both signals are present', () => {
    // "implement a process that …" — the implementation pattern matches
    // "implement" but the architecture pattern matches "process that"
    // *plus* "in parallel". Architecture should win on score.
    const res = classifyTask('implement a process that runs in parallel with the agent');
    expect(res.type).toBe(TaskType.Architecture);
  });
});

describe('parseTaskTypeOverride', () => {
  test('accepts exact category names', () => {
    expect(parseTaskTypeOverride('architecture')).toBe(TaskType.Architecture);
    expect(parseTaskTypeOverride('bugfix')).toBe(TaskType.Bugfix);
    expect(parseTaskTypeOverride('investigation')).toBe(TaskType.Investigation);
  });

  test('accepts case-insensitive prefixes', () => {
    expect(parseTaskTypeOverride('Arch')).toBe(TaskType.Architecture);
    expect(parseTaskTypeOverride('REF')).toBe(TaskType.Refactor);
  });

  test('returns null for unknown override', () => {
    expect(parseTaskTypeOverride('nonsense')).toBeNull();
    expect(parseTaskTypeOverride('')).toBeNull();
    expect(parseTaskTypeOverride(undefined)).toBeNull();
  });
});
