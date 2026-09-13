/**
 * r75 — registration-hint discovery is verified, through ONE discovery
 * authority (spec 1.3#3).
 *
 * Only a fixed `targetFile` was existence-checked; glob discovery — used when
 * the author was least sure — got nothing, so a dead glob, an ambiguous glob
 * and a single candidate with a missing anchor all read "OK". The doctor now
 * classifies each hint from the same candidate set `preview` acts on.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { coverageShortfall } from '@shrkcrft/core';
import { inspectSharkcraft, type ISharkcraftInspection } from '../sharkcraft-inspector.ts';
import {
  buildRegistrationHintDoctorReport,
  listRegistrationHints,
  previewRegistrationHint,
} from '../registration-hint-registry.ts';
import { RegistrationHintDiscoveryStatus } from '../registration-hint-discovery-status.ts';
import { buildSelfConfigDoctorReportV2 } from '../self-config-doctor-v2.ts';

const TIMEOUT_MS = 120_000;
const roots: string[] = [];

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-reghint-'));
  roots.push(root);
  const all: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
    'sharkcraft/sharkcraft.config.ts': `export default { projectName: 'fx' };\n`,
    ...files,
  };
  for (const [rel, body] of Object.entries(all)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

const HINTS = `export default [
  { id: 'rh.fixed-missing', title: 'Fixed, missing', discovery: { targetFile: 'src/registry.ts' }, operations: [{ kind: 'append', snippet: 'x' }] },
  { id: 'rh.glob-dead', title: 'Dead glob', discovery: { targetGlobs: ['src/old/**/*.ts'] }, operations: [{ kind: 'append', snippet: 'x' }] },
  { id: 'rh.glob-ambiguous', title: 'Two files', discovery: { targetGlobs: ['src/*.ts'] }, operations: [{ kind: 'append', snippet: 'x' }] },
  { id: 'rh.glob-one', title: 'One file, anchor gone', discovery: { targetGlobs: ['src/a.ts'] }, operations: [{ kind: 'insert-after', anchor: 'NOPE_ANCHOR', snippet: 'x' }] },
  { id: 'rh.half-dead', title: 'One dead glob beside a live one', discovery: { targetGlobs: ['src/a.ts', 'lib/**/*.ts'] }, operations: [{ kind: 'append', snippet: 'x' }] },
  { id: 'rh.vendored', title: 'Only under node_modules', discovery: { targetGlobs: ['**/*.target.ts'] }, operations: [{ kind: 'append', snippet: 'x' }] },
];
`;

let insp: ISharkcraftInspection;

beforeAll(async () => {
  insp = await inspectSharkcraft({
    cwd: workspace({
      'sharkcraft/registration-hints.ts': HINTS,
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
      'node_modules/pkg/x.target.ts': 'export {};\n',
    }),
  });
}, TIMEOUT_MS);

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe('r75 registration-hint discovery', () => {
  test('dead / ambiguous / verified / fixed-missing, each with its finding', async () => {
    const report = await buildRegistrationHintDoctorReport(insp);
    const status = Object.fromEntries(report.hints.map((h) => [h.id, h.status]));
    expect(status).toEqual({
      'rh.fixed-missing': RegistrationHintDiscoveryStatus.Dead,
      'rh.glob-dead': RegistrationHintDiscoveryStatus.Dead,
      'rh.glob-ambiguous': RegistrationHintDiscoveryStatus.Ambiguous,
      'rh.glob-one': RegistrationHintDiscoveryStatus.Verified,
      'rh.half-dead': RegistrationHintDiscoveryStatus.Verified,
      // node_modules is never walked: the only match is vendored → dead.
      'rh.vendored': RegistrationHintDiscoveryStatus.Dead,
    });
    const codes = report.issues.map((i) => `${i.code}|${i.hintId}|${i.target ?? ''}`);
    expect(codes).toContain('target-file-missing|rh.fixed-missing|src/registry.ts');
    expect(codes).toContain('discovery-glob-matched-nothing|rh.glob-dead|src/old/**/*.ts');
    expect(codes).toContain('discovery-dead|rh.glob-dead|(discovery)');
    expect(codes).toContain('discovery-ambiguous|rh.glob-ambiguous|(discovery)');
    expect(codes).toContain('anchor-not-present|rh.glob-one|NOPE_ANCHOR');
    // Per unit: the dead glob beside a live one is still named.
    expect(codes).toContain('discovery-glob-matched-nothing|rh.half-dead|lib/**/*.ts');
    // Round 13: `intendedEmpty` counts hints whose every empty selector is marked expectEmpty.
    expect(report.totals).toEqual({ hints: 6, verified: 2, ambiguous: 1, dead: 3, unverified: 0, intendedEmpty: 0 });
    const cov = report.coverage[0]!;
    expect(cov.unit).toBe('discovery selectors');
    expect(coverageShortfall(cov)).toBeDefined();
  });

  test('one authority: the doctor status is the classification of what preview returns', async () => {
    const report = await buildRegistrationHintDoctorReport(insp);
    for (const e of await listRegistrationHints(insp)) {
      if (!e.hint.discovery.targetGlobs) continue;
      const preview = await previewRegistrationHint(insp, e.hint.id);
      const n = preview!.candidates.length;
      const expected = n === 0 ? 'dead' : n === 1 ? 'verified' : 'ambiguous';
      expect({ id: e.hint.id, status: report.hints.find((h) => h.id === e.hint.id)!.status }).toEqual({
        id: e.hint.id,
        status: expected as RegistrationHintDiscoveryStatus,
      });
    }
  });

  test('the self-config doctor reports the same findings, and its verdict is not a pass', async () => {
    const report = await buildSelfConfigDoctorReportV2(insp);
    const codes = report.findings.map((f) => f.code);
    expect(codes).toContain('registration-hint-discovery-glob-matched-nothing');
    expect(codes).toContain('registration-hint-target-file-missing');
    expect(report.verdict).toBe('unverified');
    expect(report.deadUnits).toContain('registration hint rh.glob-dead: src/old/**/*.ts');
  });

  test(
    'a capped walk is unverified — never verified, never dead',
    async () => {
      const files: Record<string, string> = {
        'sharkcraft/registration-hints.ts': `export default [{ id: 'rh.wide', title: 'Wide', discovery: { targetGlobs: ['deep/**/*.reg.ts'] }, operations: [{ kind: 'append', snippet: 'x' }] }];\n`,
      };
      const root = workspace(files);
      for (let i = 0; i < 5050; i += 1) mkdirSync(join(root, 'deep', `d${i}`), { recursive: true });
      const i2 = await inspectSharkcraft({ cwd: root });
      const report = await buildRegistrationHintDoctorReport(i2);
      expect(report.hints[0]!.status).toBe(RegistrationHintDiscoveryStatus.Unverified);
      expect(report.coverage[0]!.capped).toBe(true);
      expect(report.issues.map((i) => i.code)).toContain('discovery-unverified');
      expect(report.deadUnits).toEqual([]);
    },
    TIMEOUT_MS,
  );

  test('lock: the v2 doctor reads no field IRegistrationHint does not declare', () => {
    const code = readFileSync(join(import.meta.dir, '..', 'self-config-doctor-v2.ts'), 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join('\n');
    expect(code).not.toContain('relatedTemplateIds');
    expect(code).not.toMatch(/e\.hint as unknown as \{/);
  });
});
