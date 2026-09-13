/**
 * r76 — `profileIds` resolve against THE WorkspaceProfile vocabulary (round
 * 12, 12.3).
 *
 * A registration hint's `discovery.profileIds` was probed against the
 * `migration-profile` registry (readiness gates, an unrelated vocabulary) and
 * relabelled `profile` — a kind no list verb shows. With no migration profiles
 * the self-config doctor sat at NOT VERIFIED (exit 2) forever; filling that
 * registry with ANY migration profile flipped it to a false "not registered"
 * for `has-typescript`, a real, detected workspace profile. Conventions'
 * `appliesTo.profileIds` was never probed at all.
 *
 * The ids now resolve against the builtin `workspace-profile` kind — the list
 * `shrk profiles list --kind workspace` prints — so the unit is measurable: a
 * real profile passes and a typo is a finding with a did-you-mean. Real
 * registries: temp workspaces with a real config, local asset files, and a
 * real pack under node_modules.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { WorkspaceProfile } from '@shrkcrft/workspace';
import { inspectSharkcraft } from '../sharkcraft-inspector.ts';
import {
  emptyReferenceKinds,
  referenceIdsFor,
  referenceKindsOf,
  warmReferenceRegistries,
} from '../reference-registry.ts';
import { listProfiles, ProfileKind } from '../profile-registry.ts';
import type { IWorkspaceProfilePayload } from '../i-workspace-profile-payload.ts';
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

/** A TypeScript consumer (so `has-typescript` is DETECTED) with a real config. */
function project(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r76-wsprofile-'));
  roots.push(root);
  write(root, 'package.json', JSON.stringify({ name: 'fx', version: '0.0.0', devDependencies: { typescript: '^5.0.0' } }));
  write(root, 'sharkcraft/sharkcraft.config.ts', "export default { projectName: 'fx' };\n");
  write(root, 'src/app.reg.ts', 'export const registry = [];\n');
  for (const [rel, body] of Object.entries(files)) write(root, rel, body);
  return root;
}

function addPack(root: string, contributions: Record<string, readonly string[]>, files: Record<string, string>): void {
  const pack = join(root, 'node_modules', '@r76', 'pack');
  write(pack, 'package.json', JSON.stringify({ name: '@r76/pack', version: '0.0.1', sharkcraft: { manifest: './manifest.json' } }));
  write(
    pack,
    'manifest.json',
    JSON.stringify({ schema: 'sharkcraft.pack/v1', info: { name: '@r76/pack', version: '0.0.1' }, contributions }),
  );
  for (const [rel, body] of Object.entries(files)) write(pack, rel, body);
}

const HINTS = (profileIds: readonly string[]): string =>
  `export default [{ id: 'rh.one', title: 'One', discovery: { targetFile: 'src/app.reg.ts', profileIds: ${JSON.stringify(profileIds)} }, operations: [{ kind: 'append', snippet: 'x' }] }];\n`;

const CONVENTIONS = (profileIds: readonly string[]): string =>
  `export default [{ id: 'conv.one', title: 'Conv', kind: 'naming', severity: 'warning', rules: [], appliesTo: { fileGlobs: ['src/**/*.ts'], profileIds: ${JSON.stringify(profileIds)} } }];\n`;

function coverageOf(report: ISelfConfigDoctorReportV2, subject: string, unit: string) {
  return report.coverage.find((c) => c.subject === subject && c.unit === unit);
}

async function doctor(root: string): Promise<ISelfConfigDoctorReportV2> {
  return buildSelfConfigDoctorReportV2(await inspectSharkcraft({ cwd: root }));
}

describe('the workspace-profile kind: list ≡ resolve, never empty', () => {
  test('resolver ids ≡ `profiles list --kind workspace` ≡ the WorkspaceProfile enum — in an EMPTY project, unwarmed', async () => {
    const insp = await inspectSharkcraft({ cwd: project({}) });
    // Sync and builtin: populated before any warm, so it can never loud-skip.
    const unwarmed = referenceIdsFor(insp, 'workspace-profile');
    expect([...unwarmed].sort()).toEqual([...Object.values(WorkspaceProfile)].sort());
    expect(emptyReferenceKinds(insp, ['workspace-profile'])).toEqual([]);
    await warmReferenceRegistries(insp);
    const listed = (await listProfiles(insp, { kind: ProfileKind.Workspace })).map((e) => e.id);
    expect([...referenceIdsFor(insp, 'workspace-profile')]).toEqual(listed);
    expect(referenceKindsOf(insp, 'has-typescript')).toEqual(['workspace-profile']);
  }, TIMEOUT_MS);

  test('each entry is builtin, labelled, and says whether THIS repo exhibits it', async () => {
    const insp = await inspectSharkcraft({ cwd: project({}) });
    const entries = await listProfiles(insp, { kind: ProfileKind.Workspace });
    const ts = entries.find((e) => e.id === 'has-typescript')!;
    expect(ts).toMatchObject({ kind: 'workspace', source: 'builtin', title: 'uses TypeScript', detected: true });
    expect((ts.payload as IWorkspaceProfilePayload).reason).toContain('typescript');
    expect(entries.find((e) => e.id === 'has-angular')).toMatchObject({ detected: false, payload: { detected: false } });
    // The unfiltered registry lists the builtin kind too (it can never print "none").
    expect((await listProfiles(insp)).filter((e) => e.kind === ProfileKind.Workspace)).toHaveLength(entries.length);
  }, TIMEOUT_MS);
});

describe('12.3 repro, inverted — registration hint discovery.profileIds', () => {
  test('a LOCAL hint naming a real profile is measured and passes (was NOT VERIFIED, exit 2)', async () => {
    const report = await doctor(project({ 'sharkcraft/registration-hints.ts': HINTS(['has-typescript']) }));
    const related = coverageOf(report, 'registration hints', 'related ids');
    expect(related).toMatchObject({ expected: 1, examined: 1 });
    expect(related?.unexamined).toBeUndefined();
    // In-process there is no injected command index, so `command strings` is
    // the one expected shortfall; nothing ELSE may be unexamined.
    expect(report.coverage.filter((c) => c.unit !== 'command strings' && c.examined < c.expected)).toEqual([]);
    expect(report.verdict).not.toBe('errors');
    expect(report.findings.filter((f) => f.targetId === 'has-typescript')).toEqual([]);
  }, TIMEOUT_MS);

  test('the SAME hint contributed by a real pack gives the identical result', async () => {
    const root = project({});
    addPack(root, { registrationHintFiles: ['./hints.ts'] }, { 'hints.ts': HINTS(['has-typescript']) });
    const report = await doctor(root);
    const related = coverageOf(report, 'registration hints', 'related ids');
    expect(related).toMatchObject({ expected: 1, examined: 1 });
    expect(related?.unexamined).toBeUndefined();
    // In-process there is no injected command index, so `command strings` is
    // the one expected shortfall; nothing ELSE may be unexamined.
    expect(report.coverage.filter((c) => c.unit !== 'command strings' && c.examined < c.expected)).toEqual([]);
    expect(report.findings.filter((f) => f.targetId === 'has-typescript')).toEqual([]);
  }, TIMEOUT_MS);

  test('a typo is ONE finding against workspace-profile, with a did-you-mean and the list verb', async () => {
    const report = await doctor(project({ 'sharkcraft/registration-hints.ts': HINTS(['has-typscript']) }));
    const missing = report.findings.filter((f) => f.code === 'registration-hint-profile-missing');
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({
      sourceKind: 'registration-hint',
      sourceId: 'rh.one',
      targetKind: 'workspace-profile',
      targetId: 'has-typscript',
      nextCommand: 'shrk profiles list --kind workspace',
    });
    expect(missing[0]!.suggestedFix).toContain('has-typescript');
    expect(coverageOf(report, 'registration hints', 'related ids')).toMatchObject({ expected: 1, examined: 1 });
  }, TIMEOUT_MS);
});

describe('conventions appliesTo.profileIds — probed at last', () => {
  test('a valid id is examined (1/1) with no finding', async () => {
    const report = await doctor(project({ 'sharkcraft/conventions.ts': CONVENTIONS(['has-angular']) }));
    expect(coverageOf(report, 'conventions', 'applicability profile ids')).toMatchObject({ expected: 1, examined: 1 });
    expect(report.findings.filter((f) => f.code === 'convention-profile-missing')).toEqual([]);
  }, TIMEOUT_MS);

  test('a typo is convention-profile-missing (info) with a did-you-mean', async () => {
    const report = await doctor(project({ 'sharkcraft/conventions.ts': CONVENTIONS(['has-angluar']) }));
    const missing = report.findings.filter((f) => f.code === 'convention-profile-missing');
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({
      severity: 'info',
      sourceKind: 'convention',
      sourceId: 'conv.one',
      targetKind: 'workspace-profile',
      targetId: 'has-angluar',
      relation: 'related',
    });
    expect(missing[0]!.suggestedFix).toContain('has-angular');
  }, TIMEOUT_MS);
});

describe('the binding moved — migration profiles are not workspace profiles', () => {
  test('a migration id in profileIds is missing; routing recommends.profiles still resolves migration ids, unrelabelled', async () => {
    const report = await doctor(
      project({
        'sharkcraft/migration-profiles.ts': `export default [{ id: 'mig.one', title: 'Mig one', checks: [] }];\n`,
        'sharkcraft/registration-hints.ts': HINTS(['mig.one']),
        'sharkcraft/task-routing-hints.ts': `export default [
  { id: 'rt.ok', title: 'Ok', match: { keywords: ['zzqok'] }, recommends: { profiles: ['mig.one'] } },
  { id: 'rt.bad', title: 'Bad', match: { keywords: ['zzqbad'] }, recommends: { profiles: ['mig.two'] } },
];\n`,
      }),
    );
    const hint = report.findings.filter((f) => f.code === 'registration-hint-profile-missing');
    expect(hint.map((f) => [f.targetKind, f.targetId])).toEqual([['workspace-profile', 'mig.one']]);
    const routing = report.findings.filter((f) => f.code === 'routing-hint-profile-missing');
    expect(routing.map((f) => [f.sourceId, f.targetKind, f.targetId])).toEqual([['rt.bad', 'migration-profile', 'mig.two']]);
    expect(report.findings.filter((f) => f.sourceId === 'rt.ok')).toEqual([]);
  }, TIMEOUT_MS);
});
