/**
 * r75 — one `shrk quality` run reads and lexes the tree ONCE for the plane
 * check and the gates-coverage pass, and a spawned command can never make that
 * shared read stale (round 11 review PERF-1).
 *
 * The coverage item re-walked, re-read and re-lexed every file the plane run
 * had just read (~0.4s on this repo). `runQuality` now opens one lex window
 * (content-keyed — it can never be stale) and one read window around both.
 * The read window is safe only because every spawn site (`compute.run`,
 * `regen`) clears the read memo right after the child exits; the first test
 * locks that, with a real command baseline rewriting a matched file.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  lexCodeZonesStats,
  planeScanExcludeDirs,
  readMatchingFiles,
  readMatchingFilesStats,
  resetLexCodeZonesStats,
  resetReadMatchingFilesStats,
  withFileReadCache,
} from '@shrkcrft/boundaries';
import type { IBaselineRule } from '@shrkcrft/core';
import { buildQualityReport, inspectSharkcraft, resolveProjectConfig } from '@shrkcrft/inspector';
import { evaluateBaselineRule } from '../commands/baseline.command.ts';
import { collectGateRules } from '../gates/gate-rule-view.ts';
import { buildGateCoverage } from '../gates/rule-coverage.ts';
import { runGatePlanes } from '../gates/run-gate-planes.ts';
import { runQuality } from '../quality/run-quality.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-sharedscan-'));
  roots.push(root);
  const all = { 'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }), ...files };
  for (const [rel, body] of Object.entries(all)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

describe('the shared read window never serves a pre-spawn snapshot', () => {
  test('a command baseline that rewrites a matched file: the next read inside the window sees the NEW bytes', () => {
    const root = project({
      'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx' };\n",
      'sharkcraft/baselines/b.txt': 'one\n',
      'src/x.ts': 'export const X = 1;\n',
    });
    const rule: IBaselineRule = {
      id: 'b-cmd',
      baseline: 'sharkcraft/baselines/b.txt',
      compute: {
        kind: 'command',
        run: `"${process.execPath}" -e "require('node:fs').writeFileSync('src/x.ts', 'export const X = 2;')"`,
      },
    };
    withFileReadCache(() => {
      expect(readMatchingFiles(root, ['src/**']).files.get('src/x.ts')).toContain('X = 1');
      evaluateBaselineRule(root, rule, [], undefined);
      expect(readMatchingFiles(root, ['src/**']).files.get('src/x.ts')).toContain('X = 2');
    });
  }, 60_000);
});

describe('one quality run shares the plane run\'s reads and lexes with the coverage pass', () => {
  test('fewer walks and fewer lexes than the three parts run on their own', async () => {
    const root = project({
      'sharkcraft/sharkcraft.config.ts':
        "export default { projectName: 'fx', " +
        // A ZONED rule (`scan: 'code'`): the policy engine lexes every unit —
        // the per-file cost the shared lex window exists to pay once.
        "policyRules: [{ id: 'no-tok', surface: 'ts', pattern: 'FORBIDDEN_TOKEN', message: 'remove it', severity: 'warning', scan: 'code' }], " +
        "wiringRules: [{ id: 'subset-rule', declared: { files: ['src/h/*.ts'], extract: 'export-names', match: '_H$' }, " +
        "registered: { files: ['src/reg.ts'], extract: 'array-members', anchor: 'H' } }] };\n",
      'src/h/a.ts': "// FORBIDDEN_TOKEN in a comment\nexport const A_H = 1;\n",
      'src/h/b.ts': 'export const B_H = 2;\n',
      'src/reg.ts': "export const H = [A_H, B_H];\nexport const s = 'FORBIDDEN_TOKEN';\n",
    });
    const inspection = await inspectSharkcraft({ cwd: root });
    const resolved = await resolveProjectConfig(root);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const rules = collectGateRules(resolved.value.config);
    const excludeDirs = planeScanExcludeDirs(root, resolved.value.sharkcraftDir);
    const measure = async (fn: () => unknown): Promise<{ walks: number; lexed: number }> => {
      resetReadMatchingFilesStats();
      resetLexCodeZonesStats();
      await fn();
      return { walks: readMatchingFilesStats().walks, lexed: lexCodeZonesStats().lexed };
    };

    const report = await measure(() => buildQualityReport({ inspection, config: {}, strict: false, callerRunsGatePlanes: true }));
    const planes = await measure(() => runGatePlanes(rules, { cwd: root, excludeDirs, inspection }));
    const coverage = await measure(() => buildGateCoverage(root, rules, excludeDirs, {}, false, inspection));
    const quality = await measure(() =>
      runQuality({ inspection, config: {}, strict: false, failFast: false, gateRules: rules, cwd: root, excludeDirs }),
    );
    expect(planes.walks).toBeGreaterThan(0);
    expect(coverage.walks).toBeGreaterThan(0);
    expect(quality.walks).toBeLessThan(report.walks + planes.walks + coverage.walks);
    expect(quality.lexed).toBeLessThan(report.lexed + planes.lexed + coverage.lexed);
  }, 120_000);
});
