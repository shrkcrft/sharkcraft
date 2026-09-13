/**
 * r76 — template metadata ids go through THE probe path (round 12, 12.3b).
 *
 * `checkTemplateMetadata` answered "does this id exist?" with bare
 * `lookups.X.has(id)` loops: `requiredProfileIds` against the MIGRATION
 * registry, and every field with no empty-registry guard. So a template naming
 * `has-typescript` (a real, detected workspace profile) got a false
 * "not registered" warning — while the SAME id in a registration hint was NOT
 * VERIFIED. Two code paths, one question, two answers.
 *
 * Every field now reads THE binding table (`PROBED_ID_FIELDS`) and `probeIds`:
 * a real profile passes, a typo warns against `workspace-profile`, and an id
 * checked against an EMPTY registry is a loud skip (NOT VERIFIED), never a
 * false miss. Real registries, temp workspaces.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspectSharkcraft } from '../sharkcraft-inspector.ts';
import { buildSelfConfigDoctorReportV2, type ISelfConfigDoctorReportV2 } from '../self-config-doctor-v2.ts';

const TIMEOUT_MS = 120_000;
const roots: string[] = [];

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function write(root: string, rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

function project(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r76-tplmeta-'));
  roots.push(root);
  write(root, 'package.json', JSON.stringify({ name: 'fx', version: '0.0.0', devDependencies: { typescript: '^5.0.0' } }));
  write(root, 'sharkcraft/sharkcraft.config.ts', "export default { projectName: 'fx' };\n");
  write(root, 'src/app.reg.ts', 'export const registry = [];\n');
  for (const [rel, body] of Object.entries(files)) write(root, rel, body);
  return root;
}

const TEMPLATES = (metadata: Readonly<Record<string, readonly string[]>>): string =>
  `export default [{ id: 'tpl.one', name: 'One', description: 'd', tags: [], scope: [], appliesWhen: [], variables: [], targetPath: () => 'src/x.ts', content: () => 'x', metadata: ${JSON.stringify(metadata)} }];\n`;

const HINTS = (discovery: Readonly<Record<string, readonly string[]>>): string =>
  `export default [{ id: 'rh.one', title: 'One', discovery: { targetFile: 'src/app.reg.ts', ...${JSON.stringify(discovery)} }, operations: [{ kind: 'append', snippet: 'x' }] }];\n`;

async function doctor(files: Readonly<Record<string, string>>): Promise<ISelfConfigDoctorReportV2> {
  return buildSelfConfigDoctorReportV2(await inspectSharkcraft({ cwd: project(files) }));
}

function coverageOf(report: ISelfConfigDoctorReportV2, subject: string, unit: string) {
  return report.coverage.find((c) => c.subject === subject && c.unit === unit);
}

type ProbeStatus = 'exists' | 'missing' | 'unverified';

/** What the doctor concluded about `id` on one path: unexamined (loud skip), a `-missing` finding, or resolved. */
function statusOf(report: ISelfConfigDoctorReportV2, source: 'template' | 'registration-hint', id: string): ProbeStatus {
  const cov =
    source === 'template'
      ? coverageOf(report, 'templates', 'required ids')
      : coverageOf(report, 'registration hints', 'related ids');
  expect(cov).toBeDefined();
  if ((cov!.unexamined ?? []).some((label) => label.endsWith(` ${id}`))) return 'unverified';
  const missing = report.findings.some((f) => f.sourceKind === source && f.targetId === id && f.code.endsWith('-missing'));
  return missing ? 'missing' : 'exists';
}

describe('template metadata.requiredProfileIds → workspace-profile', () => {
  test('a real profile with NO migration profiles declared: no finding, examined 1/1', async () => {
    const report = await doctor({ 'sharkcraft/templates.ts': TEMPLATES({ requiredProfileIds: ['has-typescript'] }) });
    expect(report.findings.filter((f) => f.code === 'template-profile-missing')).toEqual([]);
    expect(coverageOf(report, 'templates', 'required ids')).toMatchObject({ expected: 1, examined: 1 });
  }, TIMEOUT_MS);

  test('an unknown id is exactly one template-profile-missing against workspace-profile', async () => {
    const report = await doctor({ 'sharkcraft/templates.ts': TEMPLATES({ requiredProfileIds: ['nope'] }) });
    const missing = report.findings.filter((f) => f.code === 'template-profile-missing');
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({
      severity: 'warning',
      sourceKind: 'template',
      sourceId: 'tpl.one',
      targetKind: 'workspace-profile',
      targetId: 'nope',
      relation: 'requires',
      nextCommand: 'shrk profiles list --kind workspace',
    });
  }, TIMEOUT_MS);
});

describe('an EMPTY registry is a loud skip, never a false miss', () => {
  test('requiredConventionIds against ZERO conventions: no warning; the id is unexamined; verdict unverified', async () => {
    const report = await doctor({ 'sharkcraft/templates.ts': TEMPLATES({ requiredConventionIds: ['c.x'] }) });
    expect(report.findings.filter((f) => f.code === 'template-convention-missing')).toEqual([]);
    const cov = coverageOf(report, 'templates', 'required ids');
    expect(cov).toMatchObject({ expected: 1, examined: 0, unexamined: ['tpl.one → convention c.x'] });
    expect(cov!.reason).toContain('conventionFiles');
    // The record itself carries the shortfall (not only the in-process command strings).
    expect(cov!.examined).toBeLessThan(cov!.expected);
    expect(report.verdict).toBe('unverified');
  }, TIMEOUT_MS);

  test('with the convention declared, the same id resolves (examined 1/1, no finding)', async () => {
    const report = await doctor({
      'sharkcraft/templates.ts': TEMPLATES({ requiredConventionIds: ['c.x'] }),
      'sharkcraft/conventions.ts': `export default [{ id: 'c.x', title: 'X', kind: 'naming', severity: 'warning', rules: [] }];\n`,
    });
    expect(report.findings.filter((f) => f.code === 'template-convention-missing')).toEqual([]);
    expect(coverageOf(report, 'templates', 'required ids')).toMatchObject({ expected: 1, examined: 1 });
  }, TIMEOUT_MS);
});

describe('one authority — the template path and the registration-hint path agree', () => {
  test.each([
    ['requiredProfileIds', 'profileIds', 'has-typescript', 'exists'],
    ['requiredProfileIds', 'profileIds', 'has-typscript', 'missing'],
    ['requiredConventionIds', 'conventionIds', 'c.x', 'unverified'],
  ] as const)('template %s / hint discovery.%s = [%s] → both %s', async (tplField, hintField, id, want) => {
    const report = await doctor({
      'sharkcraft/templates.ts': TEMPLATES({ [tplField]: [id] }),
      'sharkcraft/registration-hints.ts': HINTS({ [hintField]: [id] }),
    });
    expect({ template: statusOf(report, 'template', id), hint: statusOf(report, 'registration-hint', id) }).toEqual({
      template: want,
      hint: want,
    });
  }, TIMEOUT_MS);
});
