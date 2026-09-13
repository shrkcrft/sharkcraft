/**
 * r75 — routing-hint load lints reach the doctor (spec 1.3#5 / 4.6#1).
 *
 * An invalid regex was swallowed at match time; a hint of only `fileGlobs`
 * scored zero forever; an empty keyword matched every task; two hints with the
 * same keywords tied forever; and `listTaskRoutingHintIssues` had NO consumer,
 * so an invalid hint or a duplicate id was invisible everywhere. Real loaders.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspectSharkcraft, type ISharkcraftInspection } from '../sharkcraft-inspector.ts';
import { explainTaskRouting, listTaskRoutingHintIssues } from '../task-routing-hint-registry.ts';
import { buildSelfConfigDoctorReportV2 } from '../self-config-doctor-v2.ts';

const TIMEOUT_MS = 60_000;
let root = '';
let insp: ISharkcraftInspection;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'shrk-r75-routinglint-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
    'src/a.ts': 'export const a = 1;\n',
    'sharkcraft/sharkcraft.config.ts': `export default { projectName: 'fx' };\n`,
    'sharkcraft/task-routing-hints.ts': `export default [
  { id: 'h.bad-regex', title: 'Bad regex', match: { keywords: ['regexy'], regexes: ['([unclosed'] }, recommends: {} },
  { id: 'h.empty', title: 'Empty keyword', match: { keywords: [''] }, recommends: {} },
  { id: 'h.dup-a', title: 'Dup A', match: { keywords: ['widget'] }, recommends: {} },
  { id: 'h.dup-b', title: 'Dup B', match: { keywords: ['Widget'] }, recommends: {} },
  { id: 'h.globs-only', title: 'Globs only', match: { fileGlobs: ['src/**/*.ts'], languages: ['typescript'] }, recommends: {} },
  { id: 'h.mixed', title: 'Mixed', match: { keywords: ['mixedword'], fileGlobs: ['src/**/*.ts'] }, recommends: {} },
  { id: 'h.invalid', match: { keywords: ['zzz'] } },
  { id: 'h.dup-a', title: 'Duplicate id', match: { keywords: ['other'] }, recommends: {} },
];
`,
  };
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  insp = await inspectSharkcraft({ cwd: root });
}, TIMEOUT_MS);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('r75 routing-hint load lints', () => {
  test('invalid regex / empty trigger / duplicate trigger', async () => {
    const issues = await listTaskRoutingHintIssues(insp);
    const by = (code: string) => issues.filter((i) => i.code === code);
    expect(by('invalid-regex').map((i) => [i.hintId, i.severity])).toEqual([['h.bad-regex', 'error']]);
    expect(by('empty-trigger').map((i) => [i.hintId, i.severity])).toEqual([['h.empty', 'error']]);
    const dup = by('duplicate-trigger');
    expect(dup).toHaveLength(1);
    expect(dup[0]!.message).toContain('"h.dup-a"');
    expect(dup[0]!.message).toContain('"h.dup-b"');
  });

  test('only unscored criteria → ONE unscored-match-criteria warning, and the matcher indeed never matches it', async () => {
    const issues = await listTaskRoutingHintIssues(insp);
    const unscored = issues.filter((i) => i.hintId === 'h.globs-only');
    expect(unscored.map((i) => [i.code, i.severity])).toEqual([['unscored-match-criteria', 'warning']]);
    const matches = await explainTaskRouting(insp, 'edit src/a.ts typescript service');
    expect(matches.some((m) => m.hint.id === 'h.globs-only')).toBe(false);
  });

  test('scored + unscored criteria → one ignored-match-criteria info, no warning', async () => {
    const issues = (await listTaskRoutingHintIssues(insp)).filter((i) => i.hintId === 'h.mixed');
    expect(issues.map((i) => [i.code, i.severity])).toEqual([['ignored-match-criteria', 'info']]);
  });

  test('an invalid hint and a duplicate id reach the self-config doctor; the verdict is errors', async () => {
    const report = await buildSelfConfigDoctorReportV2(insp);
    const codes = report.findings.map((f) => `${f.code}|${f.sourceId}`);
    expect(codes).toContain('routing-hint-invalid|h.invalid');
    expect(codes).toContain('routing-hint-duplicate-id|h.dup-a');
    expect(codes).toContain('routing-hint-invalid-regex|h.bad-regex');
    expect(codes).toContain('routing-hint-unscored-match-criteria|h.globs-only');
    // Two validator fields of h.invalid stay two findings (title, recommends).
    expect(report.findings.filter((f) => f.code === 'routing-hint-invalid')).toHaveLength(2);
    expect(report.verdict).toBe('errors');
    // A hint that can never match is a dead unit — coverage, not a pass.
    const hints = report.coverage.find((c) => c.subject === 'routing hints' && c.unit === 'hints')!;
    expect(hints.unexamined).toContain('h.globs-only');
  });

  test('lock: listTaskRoutingHintIssues has a non-test consumer (the orphan cannot return)', () => {
    const dir = join(import.meta.dir, '..');
    const consumers = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && f !== 'task-routing-hint-registry.ts')
      .filter((f) => readFileSync(join(dir, f), 'utf8').includes('listTaskRoutingHintIssues('));
    expect(consumers).toContain('self-config-doctor-v2.ts');
  });
});
