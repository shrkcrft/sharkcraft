import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEV_SESSION_SCHEMA,
  DevSessionPhase,
  DevSessionPlanStatus,
  computeDevNextAction,
  createDevSessionState,
  getDevSessionDir,
  listDevSessions,
  recomputePhase,
  recordValidation,
  renderDevSessionFinalReport,
  scanDevSession,
  setDevSessionPhase,
  upsertDevPlanEntry,
  writeDevSessionState,
  type IDevSessionLoad,
  type IDevSessionState,
  type ITaskPacket,
} from '../index.ts';

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dev-session-'));
}

function makePacket(): ITaskPacket {
  // Minimal task packet — just enough to exercise the state model.
  return {
    task: 'create profile service',
    projectOverview: 'overview',
    detectedProfiles: [],
    presetRecommendations: [],
    recommendedPipelines: [{ pipelineId: 'pipeline.a', reason: 'because' }],
    context: { body: 'context body', totalTokens: 10, sections: [] } as unknown as ITaskPacket['context'],
    relevantRules: [],
    relevantPaths: [],
    relevantTemplates: [
      { id: 'typescript.service', name: 'Service' } as ITaskPacket['relevantTemplates'][number],
    ],
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
    tokenEstimate: 10,
    suggestedGen: {
      templateId: 'typescript.service',
      templateName: 'Service',
      dryRunCommand: 'shrk gen typescript.service ...',
      applyCommand: 'shrk apply ...',
      requiredVariables: ['className'],
    },
  };
}

describe('dev-session state model', () => {
  test('createDevSessionState seeds phase=started + picks first pipeline', () => {
    const packet = makePacket();
    const state = createDevSessionState({
      id: 'sess-1',
      task: 'create profile service',
      projectRoot: '/tmp/proj',
      packet,
    });
    expect(state.schema).toBe(DEV_SESSION_SCHEMA);
    expect(state.phase).toBe(DevSessionPhase.Started);
    expect(state.selectedPipeline).toBe('pipeline.a');
    expect(state.selectedTemplates).toContain('typescript.service');
    expect(state.nextAction).toContain('shrk dev plan');
  });

  test('writeDevSessionState round-trips through scanDevSession', () => {
    const root = makeRoot();
    const packet = makePacket();
    const state = createDevSessionState({
      id: 'sess-1',
      task: 't',
      projectRoot: root,
      packet,
    });
    mkdirSync(getDevSessionDir(root, 'sess-1'), { recursive: true });
    writeDevSessionState(root, state);
    const load = scanDevSession(root, 'sess-1');
    expect(load).not.toBeNull();
    expect(load!.state).not.toBeNull();
    expect(load!.state!.phase).toBe(DevSessionPhase.Started);
    expect(load!.legacy).toBe(false);
  });

  test('scanDevSession returns legacy=true when session.json is missing', () => {
    const root = makeRoot();
    const dir = getDevSessionDir(root, 'old-session');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'task.md'), '# legacy task\n', 'utf8');
    const load = scanDevSession(root, 'old-session');
    expect(load).not.toBeNull();
    expect(load!.legacy).toBe(true);
    expect(load!.state).toBeNull();
    expect(load!.task).toBe('legacy task');
  });

  test('computeDevNextAction transitions through the workflow phases', () => {
    const root = makeRoot();
    const dir = getDevSessionDir(root, 'sess-1');
    mkdirSync(join(dir, 'plans'), { recursive: true });
    mkdirSync(join(dir, 'reports'), { recursive: true });
    writeFileSync(join(dir, 'task.md'), '# t\n', 'utf8');

    let state = createDevSessionState({
      id: 'sess-1',
      task: 't',
      projectRoot: root,
      packet: makePacket(),
    });
    writeDevSessionState(root, state);

    let load = scanDevSession(root, 'sess-1') as IDevSessionLoad;
    // 1. No plans: suggest dev plan.
    expect(computeDevNextAction(load).command).toContain('shrk dev plan');

    // 2. Add intent file → suggest filling vars.
    writeFileSync(join(dir, 'plans', 'tpl.intent.md'), 'intent', 'utf8');
    load = scanDevSession(root, 'sess-1') as IDevSessionLoad;
    const intentNext = computeDevNextAction(load);
    expect(intentNext.command).toContain('--var');

    // 3. Add a saved plan with no review → suggest review.
    writeFileSync(join(dir, 'plans', 'p.json'), '{}', 'utf8');
    load = scanDevSession(root, 'sess-1') as IDevSessionLoad;
    expect(computeDevNextAction(load).reason).toMatch(/not been reviewed/i);

    // 4. Add the review report → next is apply (human approval).
    writeFileSync(join(dir, 'reports', 'plan-review-p.json'), '{}', 'utf8');
    load = scanDevSession(root, 'sess-1') as IDevSessionLoad;
    const reviewedNext = computeDevNextAction(load);
    expect(reviewedNext.command).toContain('shrk apply');
    expect(reviewedNext.requiresHumanApproval).toBe(true);

    // 5. Record applied plan → next is validate.
    state = { ...state, appliedPlans: [{ file: 'p.json', appliedAt: 'now' }] };
    writeDevSessionState(root, state);
    load = scanDevSession(root, 'sess-1') as IDevSessionLoad;
    expect(computeDevNextAction(load).command).toContain('shrk dev validate');

    // 6. Record a passing validation → next is dev report.
    state = recordValidation(state, {
      startedAt: 's',
      finishedAt: 'f',
      reportFile: 'v.json',
      passed: true,
      warnings: 0,
      commandsRun: [],
      boundaryViolations: 0,
    });
    writeDevSessionState(root, state);
    load = scanDevSession(root, 'sess-1') as IDevSessionLoad;
    expect(computeDevNextAction(load).command).toContain('shrk dev report');

    // 7. Mark completed → next is session show.
    state = setDevSessionPhase(state, DevSessionPhase.Completed);
    writeDevSessionState(root, state);
    load = scanDevSession(root, 'sess-1') as IDevSessionLoad;
    expect(computeDevNextAction(load).command).toContain('shrk session show');
  });

  test('upsertDevPlanEntry replaces existing entry by name', () => {
    const packet = makePacket();
    let state = createDevSessionState({
      id: 'sess-1',
      task: 't',
      projectRoot: '/tmp',
      packet,
    });
    state = upsertDevPlanEntry(state, {
      name: 'user-profile',
      templateId: 'typescript.service',
      variables: {},
      missingVariables: ['className'],
      status: DevSessionPlanStatus.Intent,
      file: 'user-profile.intent.md',
      signed: false,
    });
    expect(state.plans).toHaveLength(1);
    expect(state.plans[0]!.status).toBe(DevSessionPlanStatus.Intent);
    // Replace.
    state = upsertDevPlanEntry(state, {
      name: 'user-profile',
      templateId: 'typescript.service',
      variables: { className: 'UserProfile' },
      missingVariables: [],
      status: DevSessionPlanStatus.Reviewed,
      file: 'user-profile.json',
      signed: true,
    });
    expect(state.plans).toHaveLength(1);
    expect(state.plans[0]!.status).toBe(DevSessionPlanStatus.Reviewed);
    expect(state.plans[0]!.signed).toBe(true);
  });

  test('recomputePhase prefers validation result, falls back to filesystem', () => {
    const packet = makePacket();
    let state = createDevSessionState({
      id: 'sess-1',
      task: 't',
      projectRoot: '/tmp',
      packet,
    });
    state = upsertDevPlanEntry(state, {
      name: 'p',
      templateId: 'typescript.service',
      variables: {},
      missingVariables: [],
      status: DevSessionPlanStatus.Reviewed,
      file: 'p.json',
      signed: false,
    });
    const load: IDevSessionLoad = {
      id: 'sess-1',
      dir: '/tmp/sess-1',
      task: 't',
      packet: null,
      state,
      plansOnDisk: ['p.json'],
      reportsOnDisk: [],
      intentFiles: [],
      legacy: false,
    };
    expect(recomputePhase(state, load)).toBe(DevSessionPhase.Reviewed);

    const validated = recordValidation(state, {
      startedAt: 's',
      finishedAt: 'f',
      reportFile: 'v.json',
      passed: true,
      warnings: 0,
      commandsRun: [],
      boundaryViolations: 0,
    });
    expect(recomputePhase(validated, load)).toBe(DevSessionPhase.Validated);
  });

  test('renderDevSessionFinalReport handles legacy sessions gracefully', () => {
    const load: IDevSessionLoad = {
      id: 'legacy',
      dir: '/tmp/legacy',
      task: 'old task',
      packet: null,
      state: null,
      plansOnDisk: ['x.json'],
      reportsOnDisk: ['plan-review-x.json'],
      intentFiles: [],
      legacy: true,
    };
    const md = renderDevSessionFinalReport(load);
    expect(md).toContain('# Dev session: legacy');
    expect(md).toContain('old task');
    expect(md).toContain('Legacy session');
  });

  test('listDevSessions handles a missing .sharkcraft directory', () => {
    const root = makeRoot();
    expect(listDevSessions(root)).toEqual([]);
  });

  test('state mutations are immutable — original is not modified', () => {
    const packet = makePacket();
    const original = createDevSessionState({
      id: 'sess-1',
      task: 't',
      projectRoot: '/tmp',
      packet,
    });
    const next = upsertDevPlanEntry(original, {
      name: 'p',
      templateId: 'typescript.service',
      variables: {},
      missingVariables: [],
      status: DevSessionPlanStatus.Saved,
      file: 'p.json',
      signed: false,
    });
    expect(original.plans).toHaveLength(0);
    expect(next.plans).toHaveLength(1);
    expect(next).not.toBe(original);
  });

  test('readDevSessionState rejects wrong schema versions', () => {
    const root = makeRoot();
    const dir = getDevSessionDir(root, 'wrong-schema');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'session.json'),
      JSON.stringify({ schema: 'something-else/v1', id: 'wrong-schema' }),
      'utf8',
    );
    const load = scanDevSession(root, 'wrong-schema');
    expect(load).not.toBeNull();
    expect(load!.state).toBeNull();
    expect(load!.legacy).toBe(true);
  });
});

describe('dev-session immutability invariants', () => {
  test('writeDevSessionState updates the updatedAt timestamp', async () => {
    const root = makeRoot();
    const packet = makePacket();
    const state = createDevSessionState({
      id: 'sess-time',
      task: 't',
      projectRoot: root,
      packet,
    });
    mkdirSync(getDevSessionDir(root, 'sess-time'), { recursive: true });
    const written1 = writeDevSessionState(root, state);
    await new Promise<void>((res) => setTimeout(res, 5));
    const written2 = writeDevSessionState(root, written1);
    expect(written2.updatedAt >= written1.updatedAt).toBe(true);
  });

  test('renderDevSessionFinalReport includes phase + plans + validations sections', () => {
    let state: IDevSessionState = createDevSessionState({
      id: 'sess-render',
      task: 'a task',
      projectRoot: '/tmp',
      packet: makePacket(),
    });
    state = upsertDevPlanEntry(state, {
      name: 'p',
      templateId: 'typescript.service',
      variables: { className: 'X' },
      missingVariables: [],
      status: DevSessionPlanStatus.Reviewed,
      file: 'p.json',
      signed: true,
      reviewReportFile: 'plan-review-p.json',
    });
    state = recordValidation(state, {
      startedAt: 's',
      finishedAt: 'f',
      reportFile: 'v.json',
      passed: true,
      warnings: 0,
      commandsRun: [{ command: 'echo ok', passed: true }],
      boundaryViolations: 0,
    });
    const load: IDevSessionLoad = {
      id: 'sess-render',
      dir: '/tmp/x',
      task: 'a task',
      packet: makePacket(),
      state,
      plansOnDisk: ['p.json'],
      reportsOnDisk: ['plan-review-p.json'],
      intentFiles: [],
      legacy: false,
    };
    const md = renderDevSessionFinalReport(load, { nextActionLine: 'shrk session show sess-render' });
    expect(md).toContain('## Timeline');
    expect(md).toContain('## Generated plans');
    expect(md).toContain('## Validation results');
    expect(md).toContain('PASSED');
    expect(md).toContain('shrk session show sess-render');
  });
});
