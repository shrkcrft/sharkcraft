import { describe, expect, test } from 'bun:test';
import {
  getRoleView,
  inspectSharkcraft,
  listRoleViews,
  recommendCommands,
  RoleId,
  suggestDiagnostic,
} from '../index.ts';

describe('r18 role views', () => {
  test('lists all 6 roles', () => {
    const views = listRoleViews();
    expect(views.length).toBe(6);
    expect(getRoleView(RoleId.Developer)?.role).toBe(RoleId.Developer);
  });
});

describe('r18 command recommender', () => {
  test('"review PR" returns review packet + impact', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const r = await recommendCommands(inspection, 'review my PR');
    expect(r.recommendations.some((x) => /review packet/.test(x.command))).toBe(true);
    expect(r.recommendations.some((x) => /impact/.test(x.command))).toBe(true);
  });
  test('"publish alpha" warns about not auto-publishing', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const r = await recommendCommands(inspection, 'publish alpha');
    expect(r.recommendations.some((x) => /release readiness/.test(x.command))).toBe(true);
  });
  test('"inspect code graph" routes to code-intel and graph status', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const r = await recommendCommands(inspection, 'inspect the code graph and code intelligence state');
    expect(r.recommendations.some((x) => /shrk code-intel/.test(x.command))).toBe(true);
    expect(r.recommendations.some((x) => /shrk graph status/.test(x.command))).toBe(true);
  });
  test('unknown query falls back to start-here', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const r = await recommendCommands(inspection, 'qwerty zxcvbn');
    expect(r.nextCommand).toBeDefined();
  });
});

describe('r18 diagnostics suggest', () => {
  test('matches "Unknown command" stderr to the unknown-command diagnostic', () => {
    const r = suggestDiagnostic('Unknown command: foo');
    expect(r.topSuggestion?.code).toBe('unknown-command');
  });
  test('matches "Cannot find module" to missing-node-modules', () => {
    const r = suggestDiagnostic('Error: Cannot find module @shrkcrft/foo');
    expect(r.topSuggestion?.code).toBe('missing-node-modules');
  });
  test('empty input returns no suggestion', () => {
    const r = suggestDiagnostic('');
    expect(r.topSuggestion).toBeUndefined();
  });
});
