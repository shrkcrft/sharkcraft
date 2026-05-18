import { describe, expect, test } from 'bun:test';
import { gate, type IIssueEvent } from '../src/gate.ts';

function makeEvent(
  overrides: Partial<Omit<IIssueEvent, 'issue'>> & { issue?: Partial<IIssueEvent['issue']> } = {},
): IIssueEvent {
  const { issue: issueOverride, ...rest } = overrides;
  return {
    action: 'opened',
    issue: {
      number: 1,
      title: 'placeholder',
      body: null,
      user: { login: 'someone' },
      ...issueOverride,
    },
    ...rest,
  };
}

describe('gate — opened action', () => {
  test('bence312 + [AI] prefix => plan', () => {
    const decision = gate(
      makeEvent({
        action: 'opened',
        issue: { number: 7, title: '[AI] add knob X', body: null, user: { login: 'bence312' } },
      }),
    );
    expect(decision.kind).toBe('plan');
    expect(decision.reason).toContain('bence312');
  });

  test('bence312 without [AI] prefix => ignore', () => {
    const decision = gate(
      makeEvent({
        action: 'opened',
        issue: { number: 7, title: 'normal title', body: null, user: { login: 'bence312' } },
      }),
    );
    expect(decision.kind).toBe('ignore');
    expect(decision.reason).toContain('[AI]');
  });

  test('non-allowed actor + [AI] prefix => ignore', () => {
    const decision = gate(
      makeEvent({
        action: 'opened',
        issue: { number: 7, title: '[AI] hello', body: null, user: { login: 'stranger' } },
      }),
    );
    expect(decision.kind).toBe('ignore');
    expect(decision.reason).toContain('stranger');
  });

  test('non-allowed actor without prefix => ignore', () => {
    const decision = gate(
      makeEvent({
        action: 'opened',
        issue: { number: 7, title: 'normal', body: null, user: { login: 'stranger' } },
      }),
    );
    expect(decision.kind).toBe('ignore');
  });
});

describe('gate — labeled action', () => {
  test('ai:plan applied by maintainer => plan', () => {
    const decision = gate(
      makeEvent({
        action: 'labeled',
        issue: { number: 7, title: 'whatever', body: null, user: { login: 'stranger' } },
        label: { name: 'ai:plan' },
        sender: { login: 'bence312' },
      }),
    );
    expect(decision.kind).toBe('plan');
  });

  test('ai:implement applied by maintainer => implement', () => {
    const decision = gate(
      makeEvent({
        action: 'labeled',
        issue: { number: 7, title: 'whatever', body: null, user: { login: 'stranger' } },
        label: { name: 'ai:implement' },
        sender: { login: 'bence312' },
      }),
    );
    expect(decision.kind).toBe('implement');
  });

  test('ai:plan applied by non-maintainer => ignore', () => {
    const decision = gate(
      makeEvent({
        action: 'labeled',
        issue: { number: 7, title: 'whatever', body: null, user: { login: 'stranger' } },
        label: { name: 'ai:plan' },
        sender: { login: 'stranger' },
      }),
    );
    expect(decision.kind).toBe('ignore');
    expect(decision.reason).toContain('non-maintainer');
  });

  test('ai:implement applied by non-maintainer => ignore', () => {
    const decision = gate(
      makeEvent({
        action: 'labeled',
        issue: { number: 7, title: 'whatever', body: null, user: { login: 'stranger' } },
        label: { name: 'ai:implement' },
        sender: { login: 'stranger' },
      }),
    );
    expect(decision.kind).toBe('ignore');
  });

  test('unrelated label by maintainer => ignore', () => {
    const decision = gate(
      makeEvent({
        action: 'labeled',
        issue: { number: 7, title: 'whatever', body: null, user: { login: 'stranger' } },
        label: { name: 'bug' },
        sender: { login: 'bence312' },
      }),
    );
    expect(decision.kind).toBe('ignore');
    expect(decision.reason).toContain('unrelated');
  });

  test('missing label payload => ignore', () => {
    const decision = gate(
      makeEvent({
        action: 'labeled',
        issue: { number: 7, title: 'whatever', body: null, user: { login: 'stranger' } },
        sender: { login: 'bence312' },
      }),
    );
    expect(decision.kind).toBe('ignore');
  });

  test('missing sender => ignore', () => {
    const decision = gate(
      makeEvent({
        action: 'labeled',
        issue: { number: 7, title: 'whatever', body: null, user: { login: 'stranger' } },
        label: { name: 'ai:plan' },
      }),
    );
    expect(decision.kind).toBe('ignore');
  });
});

describe('gate — unrelated actions', () => {
  test('edited action => ignore', () => {
    const decision = gate(
      makeEvent({
        action: 'edited',
        issue: { number: 7, title: '[AI] x', body: null, user: { login: 'bence312' } },
      }),
    );
    expect(decision.kind).toBe('ignore');
    expect(decision.reason).toContain('edited');
  });

  test('closed action => ignore', () => {
    const decision = gate(
      makeEvent({
        action: 'closed',
        issue: { number: 7, title: '[AI] x', body: null, user: { login: 'bence312' } },
      }),
    );
    expect(decision.kind).toBe('ignore');
  });
});
