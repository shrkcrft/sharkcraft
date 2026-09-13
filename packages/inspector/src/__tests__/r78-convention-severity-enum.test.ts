/**
 * r78 — `IConventionCheckHit.severity` and `IConventionDoctorIssue.severity`
 * are `ConventionSeverity` (round 15 follow-up, lane B — B3; F8 did the same
 * for `INotApplicableConvention`).
 *
 * Both were `'info' | 'warning' | 'error'` unions. A hit's severity is copied
 * from the convention (or its rule), which is already a `ConventionSeverity`,
 * so the union restated the enum by hand and would have drifted from it the
 * day a member changed.
 *
 * The type-level locks are compiled by the base tsc gate. Real project on
 * disk, the real loader and checker — no hand-built inspection.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ConventionSeverity } from '@shrkcrft/plugin-api';
import { inspectSharkcraft } from '../sharkcraft-inspector.ts';
import {
  checkConventionsAgainstFiles,
  loadConventions,
  type IConventionCheckHit,
  type IConventionDoctorIssue,
} from '../convention-registry.ts';

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const HIT_SEVERITY_IS_THE_ENUM: Equals<IConventionCheckHit['severity'], ConventionSeverity> = true;
const ISSUE_SEVERITY_IS_THE_ENUM: Equals<IConventionDoctorIssue['severity'], ConventionSeverity> = true;
// @ts-expect-error — a bare string literal is not a ConventionSeverity (the old union accepted one).
const LITERAL_REFUSED: IConventionCheckHit['severity'] = 'error';

const TIMEOUT_MS = 60_000;
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const NO_TS = { id: 'no-ts', description: 'no .ts file', forbidMatch: '\\.ts$' };

function project(conventions: readonly Record<string, unknown>[]): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r78-conv-severity-'));
  roots.push(root);
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
    'tsconfig.json': '{}',
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx' };\n",
    'sharkcraft/conventions.ts': `export default ${JSON.stringify(conventions, null, 2)};\n`,
    'src/a.ts': 'export const a = 1;\n',
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

const SEVERITIES: readonly string[] = Object.values(ConventionSeverity);

describe('r78 B3 — convention hits and doctor issues carry ConventionSeverity members', () => {
  test('the type-level locks hold (compiled by the base tsc gate)', () => {
    expect(HIT_SEVERITY_IS_THE_ENUM).toBe(true);
    expect(ISSUE_SEVERITY_IS_THE_ENUM).toBe(true);
    expect(LITERAL_REFUSED).toBe(ConventionSeverity.Error);
  });

  test(
    'every loader issue and every check hit is an enum member, at both levels',
    async () => {
      const root = project([
        { id: 'c.err', title: 'c.err', kind: 'naming', severity: 'error', rules: [NO_TS] },
        { id: 'c.warn', title: 'c.warn', kind: 'naming', severity: 'error', rules: [{ ...NO_TS, id: 'no-ts-w', severity: 'warning' }] },
        // Refused by the loader (no severity) — an error issue.
        { id: 'c.bad', title: 'c.bad', kind: 'naming', rules: [] },
        // A reserved filter — a shape warning that keeps the convention.
        { id: 'c.shape', title: 'c.shape', kind: 'naming', severity: 'info', appliesTo: { constructKinds: ['service'] }, rules: [NO_TS] },
      ]);
      const insp = await inspectSharkcraft({ cwd: root });
      const { issues } = await loadConventions(insp);
      expect(issues.length).toBeGreaterThanOrEqual(2);
      for (const i of issues) expect(SEVERITIES).toContain(i.severity);
      expect(issues.some((i) => i.severity === ConventionSeverity.Error && i.conventionId === 'c.bad')).toBe(true);
      expect(issues.some((i) => i.severity === ConventionSeverity.Warning && i.conventionId === 'c.shape')).toBe(true);

      const report = await checkConventionsAgainstFiles(insp, ['src/a.ts']);
      for (const h of report.hits) expect(SEVERITIES).toContain(h.severity);
      const byConvention = new Map(report.hits.map((h) => [h.conventionId, h.severity]));
      expect(byConvention.get('c.err')).toBe(ConventionSeverity.Error);
      expect(byConvention.get('c.warn')).toBe(ConventionSeverity.Warning);
      expect(byConvention.get('c.shape')).toBe(ConventionSeverity.Info);
      expect(report.verdict).toBe('has-violations');
    },
    TIMEOUT_MS,
  );
});
