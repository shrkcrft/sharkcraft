/**
 * Round 11 (6.3 / closing#d) — a changed-scope run can see a rule edit.
 *
 * `--changed-only` filters violations to the changed files, which by
 * construction cannot see a change to the rules themselves: tightening a rule
 * creates violations only in files nobody touched, and the filter used to file
 * every one of them as "legacy" — `check boundaries --changed-only` and
 * `finish` read green over the violation the edit had just introduced. A
 * changeset touching a rule's definition now ESCALATES that rule. Stateless:
 * the diff itself is the signal.
 *
 * Real `inspectSharkcraft` over a temp project with a real config and real rule
 * files — never a hand-built inspection.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  boundaryRuleSourceFiles,
  filterViolationsToChangedScope,
  inspectSharkcraft,
  resolveBoundaryRuleInvalidation,
  runBoundaryCheck,
  ChangedScopeMode,
} from '../index.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-esc-'));
  roots.push(root);
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
    'tsconfig.json': JSON.stringify({ compilerOptions: { module: 'esnext' } }),
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx', boundaryFiles: ['boundaries.ts', 'more.ts'] };\n",
    'sharkcraft/boundaries.ts':
      "export default [{ id: 'core.no-ui', title: 'core no ui', severity: 'error', from: ['src/core/**'], forbiddenImports: ['@scope/ui'] }];\n",
    'sharkcraft/more.ts':
      "export default [{ id: 'app.no-data', title: 'app no data', severity: 'error', from: ['src/app/**'], forbiddenImports: ['@scope/data'] }];\n",
    'src/core/real.ts': "import { Button } from '@scope/ui';\nexport const r = Button;\n",
    'src/app/page.ts': "import { rows } from '@scope/data';\nexport const p = rows;\n",
    'src/free/free.ts': 'export const free = 1;\n',
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

describe('resolveBoundaryRuleInvalidation — which rules a changeset invalidated', () => {
  test('a changed rule-source file escalates exactly the rules it defines', async () => {
    const inspection = await inspectSharkcraft({ cwd: project() });
    const inv = resolveBoundaryRuleInvalidation(['sharkcraft/more.ts'], inspection);
    expect(inv.escalatedRuleIds).toEqual(['app.no-data']);
    expect(inv.reasons).toEqual([{ file: 'sharkcraft/more.ts', kind: 'rule-source', ruleIds: ['app.no-data'] }]);
  });

  test('a changed sharkcraft.config.ts or tsconfig.json escalates EVERY rule', async () => {
    const inspection = await inspectSharkcraft({ cwd: project() });
    const all = ['core.no-ui', 'app.no-data'].sort();
    expect([...resolveBoundaryRuleInvalidation(['sharkcraft/sharkcraft.config.ts'], inspection).escalatedRuleIds].sort()).toEqual(all);
    expect([...resolveBoundaryRuleInvalidation(['tsconfig.json'], inspection).escalatedRuleIds].sort()).toEqual(all);
  });

  test('a changed source file escalates nothing', async () => {
    const inspection = await inspectSharkcraft({ cwd: project() });
    expect(resolveBoundaryRuleInvalidation(['src/core/real.ts', 'README.md'], inspection)).toEqual({
      escalatedRuleIds: [],
      reasons: [],
    });
  });

  test('boundaryRuleSourceFiles lists the config and every listed rule file', async () => {
    const inspection = await inspectSharkcraft({ cwd: project() });
    expect(boundaryRuleSourceFiles(inspection)).toEqual([
      'sharkcraft/boundaries.ts',
      'sharkcraft/more.ts',
      'sharkcraft/sharkcraft.config.ts',
    ]);
  });
});

describe('the changed-scope filter never files an escalated rule\'s violations as legacy', () => {
  test('every violation of an escalated rule is included, whatever its file', async () => {
    const root = project();
    const inspection = await inspectSharkcraft({ cwd: root });
    const full = runBoundaryCheck(inspection);
    expect(full.violations.map((v) => v.ruleId).sort()).toEqual(['app.no-data', 'core.no-ui']);
    const filtered = filterViolationsToChangedScope(
      full.violations,
      { projectRoot: root, files: ['sharkcraft/more.ts'] },
      { escalatedRuleIds: ['app.no-data'] },
    );
    expect(filtered.includedViolations.map((v) => v.ruleId)).toEqual(['app.no-data']);
    expect(filtered.escalatedCount).toBe(1);
    expect(filtered.ignoredLegacyCount).toBe(1);
  });

  test('runBoundaryCheck over a rule-file-only changeset escalates it and fails (never "legacy ignored")', async () => {
    const root = project();
    const inspection = await inspectSharkcraft({ cwd: root });
    const r = runBoundaryCheck(inspection, { changed: { mode: ChangedScopeMode.Files, files: ['sharkcraft/boundaries.ts'] } });
    expect(r.changed?.escalatedRuleIds).toEqual(['core.no-ui']);
    expect(r.violations.map((v) => `${v.ruleId}:${v.file}`)).toEqual(['core.no-ui:src/core/real.ts']);
    expect(r.exitCode).toBe(1);
  });

  test('with escalation suppressed the run is NOT VERIFIED — never a pass', async () => {
    const root = project();
    const inspection = await inspectSharkcraft({ cwd: root });
    const r = runBoundaryCheck(inspection, {
      changed: { mode: ChangedScopeMode.Files, files: ['sharkcraft/boundaries.ts'] },
      escalate: false,
    });
    expect(r.violations).toEqual([]);
    expect(r.changed?.escalationSuppressed).toEqual(['core.no-ui']);
    expect(r.exitCode).toBe(2);
    expect(r.shortfalls.join(' ')).toContain('--no-rule-escalation');
  });

  test('a change no rule governs selects nothing: an empty selection, not a pass', async () => {
    const root = project();
    const inspection = await inspectSharkcraft({ cwd: root });
    const r = runBoundaryCheck(inspection, { changed: { mode: ChangedScopeMode.Files, files: ['src/free/free.ts'] } });
    expect(r.selectedRuleIds).toEqual([]);
    expect(r.runCoverage.expected).toBe(0);
    expect(r.exitCode).toBe(2);
  });
});
