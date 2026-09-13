/**
 * Round 11 — the policy ENGINE owns each rule's coverage
 * (`IPolicyRuleResult.coverage`): the one record `policy-lint`, `gates check`,
 * `quality`, `shrk gate` and `finish` all settle on, so no surface re-derives
 * "did this rule examine its scope?".
 *
 * And under `--changed-only` a rule the change put NO content in front of (a
 * pure deletion, a `.ts` with no inline template under a template rule, a path
 * under an excluded dir) is narrowed out like an unselected rule — never
 * reported as a rule that "matched nothing", which `failOnEmpty` turns into a
 * failure. A matched file the scan did NOT read (over the size cap) stays in
 * scope, as a loud skip.
 *
 * Real files on disk through the real fs-backed engine.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { coverageShortfall, type IPolicyRule } from '@shrkcrft/core';
import { runPolicyLint } from '../policy/run-policy.ts';
import { MAX_SCAN_FILE_BYTES } from '../util/walk-files.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-policy-cov-'));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

const TS_RULE: IPolicyRule = {
  id: 'no-zzz',
  surface: 'ts',
  files: ['src/**/*.ts'],
  pattern: 'ZZZNEVER',
  message: 'm',
};

describe('the engine puts one coverage record on every policy rule result', () => {
  test('a rule that scanned units examined every one of them — no shortfall', () => {
    const root = tree({ 'src/a.ts': 'export const A = 1;\n', 'src/b.ts': 'export const B = 1;\n' });
    const r = runPolicyLint(root, [TS_RULE]).rules[0]!;
    expect(r.coverage).toEqual({ unit: 'content units', expected: 2, examined: 2 });
    expect(coverageShortfall(r.coverage)).toBeUndefined();
  });

  test('a rule whose globs matched nothing examined nothing — a shortfall carrying the skip reason', () => {
    const root = tree({ 'src/a.ts': 'export const A = 1;\n' });
    const stale: IPolicyRule = { ...TS_RULE, id: 'stale', files: ['nowhere/**/*.ts'], severity: 'warning', failOnEmpty: false };
    const report = runPolicyLint(root, [stale]);
    const r = report.rules[0]!;
    expect(r.status).toBe('skipped');
    expect(r.coverage).toEqual({
      unit: 'content units',
      expected: 0,
      examined: 0,
      reason: report.skipped[0]!.reason,
    });
    expect(coverageShortfall(r.coverage)).toContain('0 content units to examine');
  });

  test('a misconfigured rule examined nothing', () => {
    const root = tree({ 'src/a.ts': 'export const A = 1;\n' });
    const r = runPolicyLint(root, [{ ...TS_RULE, id: 'bad', pattern: '(' }]).rules[0]!;
    expect(r.status).toBe('error');
    expect(r.coverage).toMatchObject({ expected: 0, examined: 0, reason: 'the rule is misconfigured' });
  });
});

describe('--changed-only: a change that put no content in a rule\'s scope narrows it out', () => {
  test('a pure deletion selects the rule by path but puts nothing in scope: no rule, no failOnEmpty failure', () => {
    // Error severity → failOnEmpty defaults on. Before, this read "matched
    // nothing → FAILED" (policy-lint --changed-only exit 1) on a plain delete.
    const root = tree({ 'src/a.ts': 'export const A = 1;\n' });
    const report = runPolicyLint(root, [TS_RULE], { changedOnly: true, changedFiles: ['src/gone.ts'] });
    expect({ rules: report.rules, skipped: report.skipped, verdict: report.verdict }).toEqual({
      rules: [],
      skipped: [],
      verdict: 'pass',
    });
  });

  test('a .ts with no inline template under a template rule is narrowing; one WITH a template is scanned', () => {
    const tpl: IPolicyRule = { id: 'raw-button', surface: 'template', files: ['src/**/*.ts'], pattern: '<button', message: 'm' };
    const root = tree({
      'src/plain.ts': 'export const A = 1;\n',
      'src/x.component.ts': "@Component({\n  template: `<button>x</button>`,\n})\nexport class X {}\n",
    });
    expect(runPolicyLint(root, [tpl], { changedOnly: true, changedFiles: ['src/plain.ts'] }).rules).toEqual([]);
    const scanned = runPolicyLint(root, [tpl], { changedOnly: true, changedFiles: ['src/x.component.ts'] });
    expect(scanned.rules.map((r) => [r.ruleId, r.status, r.coverage.examined])).toEqual([['raw-button', 'failed', 1]]);
  });

  test('a changed path under an excluded dir is narrowing (no policy walk goes there)', () => {
    const root = tree({ 'sharkcraft/policies.ts': 'export const P = 1;\n', 'src/a.ts': 'export const A = 1;\n' });
    const all: IPolicyRule = { ...TS_RULE, files: ['**/*.ts'] };
    const report = runPolicyLint(root, [all], {
      changedOnly: true,
      changedFiles: ['sharkcraft/policies.ts'],
      excludeDirs: ['sharkcraft'],
    });
    expect(report.rules).toEqual([]);
  });

  test('a changed file the scan did NOT read (over the size cap) stays in scope — PARTIAL naming it, never narrowed away', () => {
    // Round 11 (integration lane): the one reader now REPORTS the unread file,
    // so the rule is no longer a "matched nothing" skip. It ran over everything
    // readable (nothing) and is `passed` with a coverage shortfall, which the
    // envelope settles `partial` (2). Its coverage names the file.
    const root = tree({ 'src/big.ts': `// ${'x'.repeat(MAX_SCAN_FILE_BYTES + 16)}\n` });
    const warn: IPolicyRule = { ...TS_RULE, severity: 'warning', failOnEmpty: false };
    const report = runPolicyLint(root, [warn], { changedOnly: true, changedFiles: ['src/big.ts'] });
    expect(report.rules.map((r) => r.status)).toEqual(['passed']);
    expect(coverageShortfall(report.rules[0]!.coverage)).toContain('src/big.ts');
  });
});
