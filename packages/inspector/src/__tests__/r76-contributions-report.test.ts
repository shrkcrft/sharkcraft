/**
 * r76 — THE contributions report (round 12, ONE-CHANGE): per contributed file,
 * entries declared · accepted · rejected, and references that cannot be
 * checked — built from the inventory, THE rejection channel and the
 * self-config doctor's OWN reference probes.
 *
 *   - a conventions file with 2 of 10 rejected is one row: declared 10,
 *     accepted 8, rejected [conv.b@1, conv.j@9] with the `severity` reason;
 *     conservation holds for every row;
 *   - a registration hint naming a convention in a workspace with NO
 *     convention registry is an unresolvable reference (`registry-empty`),
 *     attributed to its file and field, and the report's coverage is short;
 *   - one authority: the report's unresolvable references equal, as a
 *     multiset, the self-config doctor's unexamined reference units — and the
 *     doctor carries the same list.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { coverageShortfall, importModuleViaLoader, readContributionExport } from '@shrkcrft/core';
import { inspectSharkcraft } from '../sharkcraft-inspector.ts';
import { buildContributionsReport } from '../contributions-report.ts';
import { buildSelfConfigDoctorReportV2, collectUnresolvableReferences } from '../self-config-doctor-v2.ts';
import { UnresolvableReason } from '../unresolvable-reason.ts';

const TIMEOUT_MS = 180_000;
const roots: string[] = [];

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function workspace(pack: string, manifest: Record<string, readonly string[]>, files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r76-report-'));
  roots.push(root);
  const write = (rel: string, body: string): void => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  write('package.json', JSON.stringify({ name: 'fx', version: '0.0.0' }));
  write('sharkcraft/sharkcraft.config.ts', "export default { projectName: 'fx' };\n");
  write('src/a.ts', 'export const a = 1;\n');
  const dir = `node_modules/${pack}`;
  write(`${dir}/package.json`, JSON.stringify({ name: pack, version: '0.0.1', sharkcraft: { manifest: './manifest.json' } }));
  write(
    `${dir}/manifest.json`,
    JSON.stringify({ schema: 'sharkcraft.pack/v1', info: { name: pack, version: '0.0.1' }, contributions: manifest }),
  );
  for (const [rel, body] of Object.entries(files)) write(`${dir}/${rel}`, body);
  return root;
}

const convention = (id: string, severity: boolean): string =>
  `  { id: '${id}', title: '${id}', kind: 'naming', ${severity ? "severity: 'warning', " : ''}rules: [] },`;

describe('r76 the contributions report', () => {
  test(
    'one row per file — declared 10 · accepted 8 · rejected [conv.b@1, conv.j@9]; conservation holds on every row',
    async () => {
      const ids = ['conv.a', 'conv.b', 'conv.c', 'conv.d', 'conv.e', 'conv.f', 'conv.g', 'conv.h', 'conv.i', 'conv.j'];
      const root = workspace('@r76/f1', { conventionFiles: ['./conventions.ts'] }, {
        'conventions.ts': `export default [\n${ids.map((id) => convention(id, id !== 'conv.b' && id !== 'conv.j')).join('\n')}\n];\n`,
      });
      const report = await buildContributionsReport(await inspectSharkcraft({ cwd: root }));
      const row = report.files.find((f) => f.file.endsWith('/conventions.ts'))!;
      expect({
        kind: row.kind as string,
        packageName: row.packageName,
        status: row.status,
        declared: row.declared,
        accepted: row.accepted,
        rejected: row.rejected.map((r) => [r.entryId, r.index]),
      }).toEqual({
        kind: 'convention',
        packageName: '@r76/f1',
        status: 'loaded',
        declared: 10,
        accepted: 8,
        rejected: [
          ['conv.b', 1],
          ['conv.j', 9],
        ],
      });
      expect(row.rejected.every((r) => r.reasons.some((x) => x.startsWith('severity:')))).toBe(true);
      // Conservation against an INDEPENDENT count (round 12 review, T3): the
      // report computes `declared` as accepted + rejected, so comparing those
      // two could never fail. The module's own entry list — read by THE shared
      // export reader every loader uses — is the count an entry that is
      // neither accepted nor rejected would break.
      for (const f of report.files) {
        const exported = readContributionExport(await importModuleViaLoader(join(root, f.file))).items.length;
        expect({ file: f.file, exported, sum: f.accepted + f.rejected.length, declared: f.declared }).toEqual({
          file: f.file,
          exported,
          sum: exported,
          declared: exported,
        });
      }
      expect(report.totals).toMatchObject({ declared: 10, accepted: 8, rejected: 2, loadFailed: 0, unresolvable: 0 });
      expect(report.referenceCoverage).toBeUndefined();
    },
    TIMEOUT_MS,
  );

  test(
    'a reference whose kind has no registry here is unresolvable (registry-empty), attributed to its file — and doctor ≡ report',
    async () => {
      const root = workspace('@r76/refs', { registrationHintFiles: ['./registrations.ts'] }, {
        'registrations.ts':
          "export default [\n  { id: 'reg.refs', title: 'Refs', discovery: { targetFile: 'src/a.ts', conventionIds: ['conv.x', 'conv.y'] }, operations: [{ kind: 'append', snippet: 'x' }] },\n];\n",
      });
      const inspection = await inspectSharkcraft({ cwd: root });
      const report = await buildContributionsReport(inspection);
      const row = report.files.find((f) => f.file.endsWith('/registrations.ts'))!;
      expect(row.unresolvableReferences).toEqual([
        {
          sourceId: 'reg.refs',
          field: 'discovery.conventionIds',
          kind: 'convention',
          ids: ['conv.x', 'conv.y'],
          reason: UnresolvableReason.RegistryEmpty,
        },
      ]);
      expect(report.totals.unresolvable).toBe(2);
      expect(coverageShortfall(report.referenceCoverage!)).toBeDefined();

      // One authority: the doctor's unexamined reference units ≡ the report's
      // unresolvable references (multiset), and the doctor carries the list.
      const doctor = await buildSelfConfigDoctorReportV2(inspection);
      const unexamined = doctor.coverage
        .filter((c) => c.subject === 'registration hints' && c.unit === 'related ids')
        .flatMap((c) => c.unexamined ?? []);
      const fromReport = report.files.flatMap((f) =>
        f.unresolvableReferences.flatMap((g) => g.ids.map((id) => `${g.sourceId} → ${g.kind} ${id}`)),
      );
      expect([...fromReport].sort()).toEqual([...unexamined].sort());
      expect(doctor.unresolvableReferences.map((u) => `${u.sourceId}|${u.field}|${u.id}|${u.reason}`).sort()).toEqual([
        'reg.refs|discovery.conventionIds|conv.x|registry-empty',
        'reg.refs|discovery.conventionIds|conv.y|registry-empty',
      ]);
      const scan = await collectUnresolvableReferences(inspection);
      expect(scan.references.map((u) => u.id).sort()).toEqual(['conv.x', 'conv.y']);
      expect(scan.expected - scan.examined).toBe(2);
    },
    TIMEOUT_MS,
  );

  test(
    'doctor ≡ report across EVERY probed family with an empty registry — template metadata, routing recommends, registration hints (round 12 review, T4)',
    async () => {
      // Local assets, one unresolvable reference per family: no conventions and
      // no migration profiles are declared, so each id is checked against an
      // EMPTY registry (a loud skip, never a false miss).
      const root = mkdtempSync(join(tmpdir(), 'shrk-r76-report-families-'));
      roots.push(root);
      const write = (rel: string, body: string): void => {
        mkdirSync(dirname(join(root, rel)), { recursive: true });
        writeFileSync(join(root, rel), body);
      };
      write('package.json', JSON.stringify({ name: 'fx', version: '0.0.0' }));
      write('sharkcraft/sharkcraft.config.ts', "export default { projectName: 'fx' };\n");
      write('src/a.ts', 'export const a = 1;\n');
      write(
        'sharkcraft/templates.ts',
        "export default [{ id: 'tpl.refs', name: 'Refs', description: 'd', tags: [], scope: [], appliesWhen: [], variables: [], targetPath: () => 'src/x.ts', content: () => 'x', metadata: { requiredConventionIds: ['conv.none'] } }];\n",
      );
      write(
        'sharkcraft/task-routing-hints.ts',
        "export default [{ id: 'rt.refs', title: 'Refs', match: { keywords: ['zzqrefs'] }, recommends: { profiles: ['mig.none'] } }];\n",
      );
      write(
        'sharkcraft/registration-hints.ts',
        "export default [{ id: 'reg.refs', title: 'Refs', discovery: { targetFile: 'src/a.ts', conventionIds: ['conv.x'] }, operations: [{ kind: 'append', snippet: 'x' }] }];\n",
      );
      const inspection = await inspectSharkcraft({ cwd: root });
      const report = await buildContributionsReport(inspection);
      const doctor = await buildSelfConfigDoctorReportV2(inspection);

      // Tuples: (sourceId, field, kind, id) — the doctor's list ≡ the report's rows.
      const fromReport = report.files.flatMap((f) =>
        f.unresolvableReferences.flatMap((g) => g.ids.map((id) => `${g.sourceId}|${g.field}|${g.kind}|${id}`)),
      );
      const fromDoctor = doctor.unresolvableReferences.map((u) => `${u.sourceId}|${u.field}|${u.kind}|${u.id}`);
      expect([...fromReport].sort()).toEqual([...fromDoctor].sort());
      expect([...fromDoctor].sort()).toEqual([
        'reg.refs|discovery.conventionIds|convention|conv.x',
        'rt.refs|recommends.profiles|migration-profile|mig.none',
        'tpl.refs|metadata.requiredConventionIds|convention|conv.none',
      ]);

      // Labels: every id-probe coverage record's unexamined units ≡ the report's
      // `<source> → <kind> <id>` — the doctor names the KIND resolved against
      // (`migration-profile`), never a code label (`profile`).
      const PROBE_UNITS = new Set(['required ids', 'recommended ids', 'related ids', 'applicability profile ids']);
      const unexamined = doctor.coverage.filter((c) => PROBE_UNITS.has(c.unit)).flatMap((c) => c.unexamined ?? []);
      const labels = report.files.flatMap((f) =>
        f.unresolvableReferences.flatMap((g) => g.ids.map((id) => `${g.sourceId} → ${g.kind} ${id}`)),
      );
      expect([...unexamined].sort()).toEqual([...labels].sort());
      expect(unexamined).toContain('rt.refs → migration-profile mig.none');
    },
    TIMEOUT_MS,
  );
});
