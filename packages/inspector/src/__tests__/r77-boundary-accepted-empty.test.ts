/**
 * r77 — a boundary rule accepted as intended-empty, as the inspector surfaces
 * read it (round 13):
 *
 *   - K6: THE "rules evaluated" count (`boundaryRulesEvaluated`, which `check
 *     boundaries --json`, `diff-check` and MCP `check_boundaries` all read)
 *     never counts a rule that examined 0 files because it is intended-empty;
 *     `boundaryRulesAcceptedEmpty` lists it instead;
 *   - the dashboard boundary panel says "accepted" only when the settle
 *     accepted — an acceptance exists at exit 0 alone, so a failing run holds
 *     the same units as "intended empty" (review: `… 1 expectEmpty unit(s)
 *     accepted` at exit 1, with `accepted: []`).
 *
 * Real workspaces, the real loader and inspection, in-process.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildDashboardBoundaries } from '../dashboard/dashboard-data.ts';
import {
  boundaryRulesAcceptedEmpty,
  boundaryRulesCheckedNothing,
  boundaryRulesEvaluated,
  runBoundaryCheck,
} from '../run-boundary-check.ts';
import { inspectSharkcraft } from '../sharkcraft-inspector.ts';

const TIMEOUT_MS = 60_000;
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function workspace(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r77-bnd-accepted-'));
  roots.push(root);
  const all: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx', boundaryFiles: ['boundaries.ts'] };\n",
    ...files,
  };
  for (const [rel, body] of Object.entries(all)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

/** One live fence (with a planned forbidden unit) and one rule wholly ahead of its directory. */
const RULES = `export default [
  { id: 'app.no-fs', title: 'app never imports fs', from: ['src/app/**'],
    forbiddenImports: ['node:fs', { pattern: '@census/future', expectEmpty: true, reason: 'planned SDK' }] },
  { id: 'plugins.no-fs', title: 'plugins never import fs', from: [{ pattern: 'src/plugins/**', expectEmpty: true }],
    forbiddenImports: ['node:fs'] },
];\n`;

describe('r77 boundaries — an intended-empty rule is accepted, never evaluated (K6)', () => {
  test(
    'boundaryRulesEvaluated counts the live rule only; the planned one is boundaryRulesAcceptedEmpty',
    async () => {
      const root = workspace({ 'sharkcraft/boundaries.ts': RULES, 'src/app/a.ts': 'export const a = 1;\n' });
      const r = runBoundaryCheck(await inspectSharkcraft({ cwd: root }));
      expect(r.exitCode).toBe(0);
      expect(r.rules.map((x) => x.ruleId)).toEqual(['app.no-fs', 'plugins.no-fs']);
      expect(boundaryRulesEvaluated(r)).toBe(1);
      expect(boundaryRulesAcceptedEmpty(r).map((x) => x.ruleId)).toEqual(['plugins.no-fs']);
      expect(boundaryRulesCheckedNothing(r)).toEqual([]);
      // The engine agrees with the orchestrator's count.
      expect([r.evaluation.rulesEvaluated, r.evaluation.rulesAcceptedEmpty]).toEqual([1, 1]);
      // …and the acceptance is printed, not hidden: it is in the settled lines.
      expect(r.accepted.some((a) => a.startsWith('plugins.no-fs: accepted by expectEmpty'))).toBe(true);
    },
    TIMEOUT_MS,
  );
});

describe('r77 dashboard boundary panel — "accepted" only over an acceptance', () => {
  test(
    'exit 0: the intended-empty units read accepted (the settle printed their acceptance)',
    async () => {
      const root = workspace({ 'sharkcraft/boundaries.ts': RULES, 'src/app/a.ts': 'export const a = 1;\n' });
      const panel = buildDashboardBoundaries(await inspectSharkcraft({ cwd: root }));
      expect(panel.exitCode).toBe(0);
      expect(panel.summary).toContain('No active violations — 2 rule(s) checked.');
      expect(panel.summary).toContain('2 expectEmpty unit(s) accepted');
    },
    TIMEOUT_MS,
  );

  test(
    'exit 1: a failing run never says "accepted" — the same units read intended empty',
    async () => {
      const root = workspace({
        'sharkcraft/boundaries.ts': RULES,
        'src/app/a.ts': "import { readFileSync } from 'node:fs';\nexport const a = readFileSync;\n",
      });
      const inspection = await inspectSharkcraft({ cwd: root });
      const r = runBoundaryCheck(inspection);
      expect(r.exitCode).toBe(1);
      expect(r.accepted).toEqual([]);
      expect(r.intendedEmpty.length).toBe(2);
      const panel = buildDashboardBoundaries(inspection);
      expect(panel.exitCode).toBe(1);
      expect(panel.summary).toContain('Boundary check needs attention — 1 violation(s)');
      expect(panel.summary).toContain('2 expectEmpty unit(s) intended empty');
      expect(panel.summary).not.toContain('accepted');
    },
    TIMEOUT_MS,
  );
});
