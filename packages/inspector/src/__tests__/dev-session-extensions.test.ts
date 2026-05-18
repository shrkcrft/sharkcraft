import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  archiveDevSession,
  createDevSessionState,
  detectSessionFromPlanPath,
  DevSessionPhase,
  DevSessionPlanStatus,
  DevSessionSignatureStatus,
  diffDevSessions,
  getDevSessionDir,
  getSessionsArchiveRoot,
  isDevSessionActive,
  listDevCleanCandidates,
  listDevSessionsDetailed,
  parseDurationToMs,
  recordAppliedPlan,
  recomputePhase,
  recordValidation,
  scanDevSession,
  setDevSessionPhase,
  upsertDevPlanEntry,
  writeDevSessionState,
  type IDevSessionLoad,
  type ITaskPacket,
} from '../index.ts';

function makePacket(): ITaskPacket {
  return {
    task: 't',
    projectOverview: '',
    detectedProfiles: [],
    presetRecommendations: [],
    recommendedPipelines: [],
    context: { body: '', totalTokens: 0, sections: [] } as unknown as ITaskPacket['context'],
    relevantRules: [],
    relevantPaths: [],
    relevantTemplates: [],
    actionHints: {
      commands: [],
      mcpTools: [],
      forbiddenActions: [],
      verificationCommands: [],
    } as unknown as ITaskPacket['actionHints'],
    recommendedMcpTools: [],
    recommendedCliCommands: [],
    forbiddenActions: [],
    verificationCommands: [],
    humanReviewPoints: [],
    tokenEstimate: 0,
  };
}

function makeSession(root: string, id: string, task: string) {
  mkdirSync(join(getDevSessionDir(root, id), 'plans'), { recursive: true });
  mkdirSync(join(getDevSessionDir(root, id), 'reports'), { recursive: true });
  writeFileSync(join(getDevSessionDir(root, id), 'task.md'), `# ${task}\n`);
  const state = createDevSessionState({ id, task, projectRoot: root, packet: makePacket() });
  writeDevSessionState(root, state);
}

describe('detectSessionFromPlanPath', () => {
  test('detects plans inside .sharkcraft/sessions/<id>/plans/', () => {
    const root = '/tmp/proj';
    const planPath = '/tmp/proj/.sharkcraft/sessions/2026-01-01-test/plans/foo.json';
    const r = detectSessionFromPlanPath(planPath, root);
    expect(r).not.toBeNull();
    expect(r!.sessionId).toBe('2026-01-01-test');
    expect(r!.planFile).toBe('foo.json');
  });

  test('returns null for plans outside the sessions tree', () => {
    expect(detectSessionFromPlanPath('/tmp/proj/plans/foo.json', '/tmp/proj')).toBeNull();
    expect(detectSessionFromPlanPath('/tmp/proj/.sharkcraft/foo.json', '/tmp/proj')).toBeNull();
  });

  test('returns null when nesting is wrong (extra/missing levels)', () => {
    expect(
      detectSessionFromPlanPath('/tmp/proj/.sharkcraft/sessions/foo.json', '/tmp/proj'),
    ).toBeNull();
    expect(
      detectSessionFromPlanPath(
        '/tmp/proj/.sharkcraft/sessions/id/plans/sub/foo.json',
        '/tmp/proj',
      ),
    ).toBeNull();
  });
});

describe('recordAppliedPlan with signature/divergence', () => {
  test('records changedFiles + signatureStatus + divergenceAccepted', () => {
    const root = mkdtempSync(join(tmpdir(), 'dev-session-ext-'));
    makeSession(root, 'sess-1', 'task');
    const load = scanDevSession(root, 'sess-1')!;
    let state = recordAppliedPlan(load.state!, {
      file: 'plan.json',
      appliedAt: 'now',
      changedFiles: ['src/foo.ts', 'src/bar.ts'],
      signatureStatus: DevSessionSignatureStatus.Verified,
      divergenceAccepted: false,
      conflicts: [],
    });
    expect(state.appliedPlans.length).toBe(1);
    expect(state.appliedPlans[0]!.changedFiles).toEqual(['src/foo.ts', 'src/bar.ts']);
    expect(state.appliedPlans[0]!.signatureStatus).toBe(DevSessionSignatureStatus.Verified);
    expect(state.appliedPlans[0]!.divergenceAccepted).toBe(false);
  });
});

describe('recomputePhase with ValidationFailed', () => {
  test('failed last validation produces validation_failed phase', () => {
    const root = mkdtempSync(join(tmpdir(), 'dev-session-ext-'));
    makeSession(root, 'sess-1', 'task');
    const load = scanDevSession(root, 'sess-1')!;
    let state = recordValidation(load.state!, {
      startedAt: 's',
      finishedAt: 'f',
      reportFile: 'v.json',
      passed: false,
      warnings: 0,
      commandsRun: [],
      boundaryViolations: 0,
    });
    expect(recomputePhase(state, load)).toBe(DevSessionPhase.ValidationFailed);
  });
});

describe('parseDurationToMs', () => {
  test('handles common units', () => {
    expect(parseDurationToMs('30m')).toBe(30 * 60_000);
    expect(parseDurationToMs('24h')).toBe(24 * 3_600_000);
    expect(parseDurationToMs('7d')).toBe(7 * 86_400_000);
    expect(parseDurationToMs('2w')).toBe(2 * 604_800_000);
    expect(parseDurationToMs('bad')).toBeNull();
  });
});

describe('archiveDevSession', () => {
  test('moves the session dir to sessions-archive/', () => {
    const root = mkdtempSync(join(tmpdir(), 'dev-session-arc-'));
    makeSession(root, 'sess-1', 'task');
    const r = archiveDevSession(root, 'sess-1');
    expect(r.archived).toBe(true);
    expect(existsSync(getDevSessionDir(root, 'sess-1'))).toBe(false);
    expect(existsSync(join(getSessionsArchiveRoot(root), 'sess-1'))).toBe(true);
  });

  test('refuses when an archive entry already exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'dev-session-arc-'));
    makeSession(root, 'sess-1', 'task');
    archiveDevSession(root, 'sess-1');
    makeSession(root, 'sess-1', 'task again');
    const r = archiveDevSession(root, 'sess-1');
    expect(r.archived).toBe(false);
    expect(r.reason).toContain('exists');
  });
});

describe('listDevCleanCandidates / isDevSessionActive', () => {
  test('active sessions are skipped unless --include-active', () => {
    const root = mkdtempSync(join(tmpdir(), 'dev-session-clean-'));
    makeSession(root, 'sess-1', 'task');
    let state = scanDevSession(root, 'sess-1')!.state!;
    state = upsertDevPlanEntry(state, {
      name: 'p',
      templateId: 't',
      variables: {},
      missingVariables: [],
      status: DevSessionPlanStatus.Reviewed,
      file: 'p.json',
      signed: false,
    });
    writeDevSessionState(root, state);
    // 1ms threshold so this is treated as "old".
    const r = listDevCleanCandidates({ cwd: root, olderThanMs: 0, now: Date.now() + 1_000_000 });
    expect(r.length).toBe(1);
    expect(r[0]!.active).toBe(true);
    expect(r[0]!.reason).toContain('active');
    // With includeActive, the candidate becomes eligible.
    const r2 = listDevCleanCandidates({
      cwd: root,
      olderThanMs: 0,
      includeActive: true,
      now: Date.now() + 1_000_000,
    });
    expect(r2[0]!.reason).toBe('eligible');
  });

  test('completed sessions are not active', () => {
    const root = mkdtempSync(join(tmpdir(), 'dev-session-clean-'));
    makeSession(root, 'sess-2', 'task');
    let state = scanDevSession(root, 'sess-2')!.state!;
    state = setDevSessionPhase(state, DevSessionPhase.Completed);
    writeDevSessionState(root, state);
    const load = scanDevSession(root, 'sess-2')!;
    expect(isDevSessionActive(load)).toBe(false);
  });
});

describe('diffDevSessions', () => {
  test('reports changed phase + new plans', () => {
    const root = mkdtempSync(join(tmpdir(), 'dev-session-diff-'));
    makeSession(root, 'a', 'task A');
    makeSession(root, 'b', 'task B');
    let stateB = scanDevSession(root, 'b')!.state!;
    stateB = upsertDevPlanEntry(stateB, {
      name: 'p',
      templateId: 't',
      variables: {},
      missingVariables: [],
      status: DevSessionPlanStatus.Saved,
      file: 'p.json',
      signed: false,
    });
    stateB = setDevSessionPhase(stateB, DevSessionPhase.Planned);
    writeDevSessionState(root, stateB);
    const a = scanDevSession(root, 'a')!;
    const b = scanDevSession(root, 'b')!;
    const diff = diffDevSessions(a, b);
    expect(diff.phase.changed).toBe(true);
    expect(diff.plans.onlyB.includes('p')).toBe(true);
  });
});

describe('listDevSessionsDetailed', () => {
  test('returns id, phase, task, next action', () => {
    const root = mkdtempSync(join(tmpdir(), 'dev-session-list-'));
    makeSession(root, 'a', 'one');
    makeSession(root, 'b', 'two');
    const items = listDevSessionsDetailed(root);
    expect(items.length).toBe(2);
    expect(items.some((i) => i.id === 'a' && i.task === 'one')).toBe(true);
  });
});
