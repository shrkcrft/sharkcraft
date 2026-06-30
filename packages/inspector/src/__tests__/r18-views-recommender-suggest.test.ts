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
  test('scaffolding intent that overlaps a recipe keyword headlines the ranker template, not release/review tooling', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    // "release" overlaps the publish/release recipe, but the intent is to
    // scaffold a cli command — the shared ranker matches that template.
    const r = await recommendCommands(
      inspection,
      'create a new cli command for the release tooling',
    );
    // Headline is the ranker-matched generator, NOT the release recipe.
    expect(r.recommendations[0]!.command).toMatch(/^shrk gen /);
    expect(r.nextCommand).toMatch(/^shrk gen /);
    expect(r.recommendations[0]!.command).not.toMatch(/release readiness|review packet/);
    // Keyword overlap alone must NOT be stamped HIGH — divergent signals
    // (recipe vs. stronger ranker match) drop confidence to medium + a review note.
    expect(r.uncertainty.confidence).toBe('medium');
    expect(r.uncertainty.conflictingSignals.length).toBeGreaterThan(0);
    expect(r.warnings.some((w) => /^review:/.test(w))).toBe(true);
  });
  test('pure-recipe match (no competing ranker) keeps HIGH confidence', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const r = await recommendCommands(inspection, 'review my PR');
    expect(r.recommendations.some((x) => /review packet/.test(x.command))).toBe(true);
    expect(r.uncertainty.confidence).toBe('high');
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
