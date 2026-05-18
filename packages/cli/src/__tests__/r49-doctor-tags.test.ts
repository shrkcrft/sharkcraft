/**
 * Doctor source/state tagging + advisory folding.
 */
import { describe, expect, test } from 'bun:test';
import { DoctorSeverity, type IDoctorCheck } from '@shrkcrft/inspector';
import {
  classifySource,
  classifyState,
  DoctorSource,
  DoctorState,
  foldDoctorChecks,
  renderFoldedSummary,
} from '../doctor/doctor-tags.ts';

function check(
  id: string,
  severity: DoctorSeverity,
  extras: Partial<IDoctorCheck> = {},
): IDoctorCheck {
  return {
    id,
    title: id,
    severity,
    message: `message-${id}`,
    ...extras,
  };
}

describe('classifySource', () => {
  test('pack- prefix → pack', () => {
    expect(classifySource(check('pack-conflict', DoctorSeverity.Warning))).toBe(
      DoctorSource.Pack,
    );
    expect(
      classifySource(check('stale-pack-signature', DoctorSeverity.Warning)),
    ).toBe(DoctorSource.Pack);
  });

  test('config / self-config / sharkcraft-folder → built-in', () => {
    expect(classifySource(check('config-missing', DoctorSeverity.Error))).toBe(
      DoctorSource.BuiltIn,
    );
    expect(
      classifySource(check('self-config-graph', DoctorSeverity.Warning)),
    ).toBe(DoctorSource.BuiltIn);
    expect(
      classifySource(check('sharkcraft-folder-missing', DoctorSeverity.Warning)),
    ).toBe(DoctorSource.BuiltIn);
  });

  test('knowledge / template / rules / paths → local', () => {
    expect(
      classifySource(check('knowledge-stale-x', DoctorSeverity.Warning)),
    ).toBe(DoctorSource.Local);
    expect(
      classifySource(check('template-drift-foo', DoctorSeverity.Warning)),
    ).toBe(DoctorSource.Local);
    expect(classifySource(check('rules-missing', DoctorSeverity.Warning))).toBe(
      DoctorSource.Local,
    );
    expect(
      classifySource(check('actionhints-missing-x', DoctorSeverity.Warning)),
    ).toBe(DoctorSource.Local);
  });

  test('unknown id → unknown', () => {
    expect(classifySource(check('zzz-mystery', DoctorSeverity.Warning))).toBe(
      DoctorSource.Unknown,
    );
  });
});

describe('classifyState', () => {
  const noAck = { acknowledgements: [], expiredAcknowledgements: [] };

  test('error → blocker', () => {
    expect(classifyState(check('x', DoctorSeverity.Error), noAck)).toBe(
      DoctorState.Blocker,
    );
  });

  test('warning + advisory:true → advisory', () => {
    expect(
      classifyState(check('x', DoctorSeverity.Warning, { advisory: true }), noAck),
    ).toBe(DoctorState.Advisory);
  });

  test('warning without advisory → active', () => {
    expect(classifyState(check('x', DoctorSeverity.Warning), noAck)).toBe(
      DoctorState.Active,
    );
  });

  test('acknowledged when an active ack matches by id', () => {
    const state = classifyState(check('x', DoctorSeverity.Warning), {
      acknowledgements: [{ id: 'x', reason: 'r' }],
      expiredAcknowledgements: [],
    });
    expect(state).toBe(DoctorState.Acknowledged);
  });

  test('expired-acknowledgement takes priority', () => {
    const state = classifyState(check('x', DoctorSeverity.Warning), {
      acknowledgements: [],
      expiredAcknowledgements: [{ id: 'x', reason: 'r', expiresAt: '2000-01-01' }],
    });
    expect(state).toBe(DoctorState.ExpiredAcknowledgement);
  });
});

describe('foldDoctorChecks', () => {
  const noAck = { acknowledgements: [], expiredAcknowledgements: [] };

  test('default folds advisory + acknowledged into the summary', () => {
    const view = foldDoctorChecks(
      [
        check('blocker1', DoctorSeverity.Error),
        check('active1', DoctorSeverity.Warning),
        check('advisory1', DoctorSeverity.Warning, { advisory: true }),
      ],
      { ack: noAck },
    );
    expect(view.visible.map((t) => t.check.id)).toEqual(['blocker1', 'active1']);
    expect(view.folded.map((t) => t.check.id)).toEqual(['advisory1']);
    expect(view.counts[DoctorState.Advisory]).toBe(1);
  });

  test('--show-advisory keeps every warning visible', () => {
    const view = foldDoctorChecks(
      [
        check('blocker1', DoctorSeverity.Error),
        check('advisory1', DoctorSeverity.Warning, { advisory: true }),
      ],
      { ack: noAck, showAdvisory: true },
    );
    expect(view.visible.length).toBe(2);
    expect(view.folded.length).toBe(0);
  });

  test('--strict (showAll) keeps every warning visible even when acknowledged', () => {
    const view = foldDoctorChecks(
      [
        check('active1', DoctorSeverity.Warning),
        check('ack1', DoctorSeverity.Warning),
      ],
      {
        ack: { acknowledgements: [{ id: 'ack1', reason: 'r' }], expiredAcknowledgements: [] },
        showAll: true,
      },
    );
    expect(view.visible.length).toBe(2);
    expect(view.folded.length).toBe(0);
  });

  test('expired-acknowledgement stays visible (it needs attention)', () => {
    const view = foldDoctorChecks(
      [check('exp1', DoctorSeverity.Warning)],
      {
        ack: {
          acknowledgements: [],
          expiredAcknowledgements: [{ id: 'exp1', reason: 'r', expiresAt: '2000-01-01' }],
        },
      },
    );
    expect(view.visible.length).toBe(1);
    expect(view.tagged[0]?.state).toBe(DoctorState.ExpiredAcknowledgement);
  });

  test('renderFoldedSummary returns empty string when nothing is folded', () => {
    const view = foldDoctorChecks([check('a', DoctorSeverity.Warning)], { ack: noAck });
    expect(renderFoldedSummary(view)).toBe('');
  });

  test('renderFoldedSummary mentions every non-zero bucket', () => {
    const view = foldDoctorChecks(
      [
        check('adv1', DoctorSeverity.Warning, { advisory: true }),
        check('ack1', DoctorSeverity.Warning),
      ],
      {
        ack: {
          acknowledgements: [{ id: 'ack1', reason: 'r' }],
          expiredAcknowledgements: [],
        },
      },
    );
    const summary = renderFoldedSummary(view);
    expect(summary).toContain('1 advisory');
    expect(summary).toContain('1 acknowledged');
    expect(summary).toContain('--show-advisory');
  });
});
