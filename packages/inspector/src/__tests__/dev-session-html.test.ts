import { describe, expect, test } from 'bun:test';
import {
  createDevSessionState,
  DevSessionPhase,
  DevSessionPlanStatus,
  recordValidation,
  renderDevSessionHtml,
  setDevSessionPhase,
  upsertDevPlanEntry,
  type IDevSessionLoad,
  type IDevSessionState,
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

function makeLoad(stateOverrides?: Partial<IDevSessionState>): IDevSessionLoad {
  let state = createDevSessionState({
    id: 'sess-html',
    task: 'render a <bold>html</bold> view',
    projectRoot: '/tmp/proj',
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
  state = setDevSessionPhase(state, DevSessionPhase.Validated);
  return {
    id: 'sess-html',
    dir: '/tmp/proj/.sharkcraft/sessions/sess-html',
    task: 'render a <bold>html</bold> view',
    packet: makePacket(),
    state: { ...state, ...stateOverrides },
    plansOnDisk: ['p.json'],
    reportsOnDisk: ['plan-review-p.json', 'v.json'],
    intentFiles: [],
    legacy: false,
  };
}

describe('renderDevSessionHtml', () => {
  test('produces a full HTML document', () => {
    const html = renderDevSessionHtml(makeLoad());
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<title>SharkCraft session sess-html</title>');
    expect(html).toContain('</html>');
  });

  test('escapes HTML in task and other user-provided strings', () => {
    const html = renderDevSessionHtml(makeLoad());
    expect(html).not.toContain('<bold>html</bold>');
    expect(html).toContain('&lt;bold&gt;html&lt;/bold&gt;');
  });

  test('renders the phase, plans table, and validation results', () => {
    const html = renderDevSessionHtml(makeLoad());
    expect(html).toContain('phase phase-validated');
    expect(html).toContain('p.json');
    expect(html).toContain('PASSED');
    expect(html).toContain('echo ok');
  });

  test('renders next action when provided', () => {
    const html = renderDevSessionHtml(makeLoad(), { nextActionLine: 'shrk dev report sess-html' });
    expect(html).toContain('shrk dev report sess-html');
  });

  test('renders the commands cheat sheet block', () => {
    const html = renderDevSessionHtml(makeLoad());
    expect(html).toContain('shrk dev plan sess-html');
    expect(html).toContain('shrk apply');
    expect(html).toContain('shrk dev validate');
  });

  test('legacy session falls back to a warning notice', () => {
    const load: IDevSessionLoad = {
      id: 'legacy',
      dir: '/tmp/legacy',
      task: 'old',
      packet: null,
      state: null,
      plansOnDisk: ['x.json'],
      reportsOnDisk: [],
      intentFiles: [],
      legacy: true,
    };
    const html = renderDevSessionHtml(load);
    expect(html).toContain('Legacy session');
  });
});
