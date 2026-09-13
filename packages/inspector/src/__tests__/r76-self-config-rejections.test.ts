/**
 * r76 — the round-12 report's own shape reaches every doctor (12.1).
 *
 * A pack's conventions file declares 10 conventions; `conv.b` and `conv.j`
 * omit the required `severity`. Before round 12 the list printed 8, the
 * self-config doctor said `errors 0` and `packs doctor` said `OK ✓` — the two
 * were dropped at load with no signal outside `conventions doctor`. Asserted
 * on a real pack through the real doctors:
 *
 *   - the self-config doctor: exactly two `convention-invalid` ERRORs naming
 *     `conv.b` / `conv.j` and `severity`, verdict `errors`;
 *   - a routing hint missing `recommends` is ONE `routing-hint-invalid` (the
 *     family's own copy is gone — one reporter per rejection);
 *   - a reference to a REJECTED id says it was declared and rejected, not
 *     "did you mean";
 *   - `packs doctor`: `contribution-entries-rejected` — `2 of 10` — with the
 *     `satisfies IConvention[]` / `--typecheck` pointer; not passed.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspectSharkcraft, type ISharkcraftInspection } from '../sharkcraft-inspector.ts';
import { buildSelfConfigDoctorReportV2, isUnresolvedReferenceFinding, type ISelfConfigDoctorReportV2 } from '../self-config-doctor-v2.ts';
import { buildPackDoctorReportAsync, type IPackDoctorReport } from '../pack-doctor.ts';

const TIMEOUT_MS = 180_000;
let root = '';
let inspection: ISharkcraftInspection;
let report: ISelfConfigDoctorReportV2;
let packDoctor: IPackDoctorReport;

function write(rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

const convention = (id: string, severity: boolean): string =>
  `  { id: '${id}', title: '${id}', kind: 'naming', ${severity ? "severity: 'warning', " : ''}rules: [] },`;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'shrk-r76-f1-'));
  write('package.json', JSON.stringify({ name: 'f1', version: '0.0.0' }));
  write('sharkcraft/sharkcraft.config.ts', "export default { projectName: 'f1' };\n");
  write('src/a.ts', 'export const a = 1;\n');
  const pack = 'node_modules/@r76/f1';
  write(`${pack}/package.json`, JSON.stringify({ name: '@r76/f1', version: '0.0.1', sharkcraft: { manifest: './manifest.json' } }));
  write(
    `${pack}/manifest.json`,
    JSON.stringify({
      schema: 'sharkcraft.pack/v1',
      info: { name: '@r76/f1', version: '0.0.1' },
      contributions: {
        conventionFiles: ['./conventions.ts'],
        taskRoutingHintFiles: ['./routing.ts'],
        registrationHintFiles: ['./registrations.ts'],
      },
    }),
  );
  const ids = ['conv.a', 'conv.b', 'conv.c', 'conv.d', 'conv.e', 'conv.f', 'conv.g', 'conv.h', 'conv.i', 'conv.j'];
  write(
    `${pack}/conventions.ts`,
    // A local interface declares `severity` required — and is never applied:
    // the build is a transpile, so only the RUNTIME validator can catch it.
    `interface ILocalConvention { id: string; title: string; kind: string; severity: string; rules: unknown[] }\n` +
      `export default [\n${ids.map((id) => convention(id, id !== 'conv.b' && id !== 'conv.j')).join('\n')}\n];\n`,
  );
  write(
    `${pack}/routing.ts`,
    "export default [\n  { id: 'rh.ok', title: 'Ok', match: { keywords: ['alpha'] }, recommends: { commands: [] } },\n  { id: 'rh.norec', title: 'No recommends', match: { keywords: ['beta'] } },\n];\n",
  );
  write(
    `${pack}/registrations.ts`,
    "export default [\n  { id: 'reg.refs', title: 'Refs', discovery: { targetFile: 'src/a.ts', conventionIds: ['conv.a', 'conv.b'] }, operations: [{ kind: 'append', snippet: 'x' }] },\n];\n",
  );
  inspection = await inspectSharkcraft({ cwd: root });
  report = await buildSelfConfigDoctorReportV2(inspection);
  packDoctor = await buildPackDoctorReportAsync(inspection);
}, TIMEOUT_MS);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('r76 a rejected contributed entry reaches the doctors', () => {
  test('the self-config doctor: exactly two convention-invalid ERRORs naming conv.b / conv.j and severity', () => {
    const invalid = report.findings.filter((f) => f.code === 'convention-invalid');
    expect(invalid.map((f) => [f.sourceId, f.targetId, f.severity]).sort()).toEqual([
      ['conv.b', 'severity', 'error'],
      ['conv.j', 'severity', 'error'],
    ]);
    expect(invalid[0]!.message).toContain('rejected by its loader');
    expect(invalid[0]!.nextCommand).toBe('shrk packs contributions --pack @r76/f1');
    expect(report.verdict).toBe('errors');
  });

  test('a routing hint missing `recommends` is ONE routing-hint-invalid — never a second copy', () => {
    const hits = report.findings.filter((f) => f.code === 'routing-hint-invalid');
    expect(hits.map((f) => [f.sourceId, f.targetId])).toEqual([['rh.norec', 'recommends']]);
  });

  test('a reference to a REJECTED id says it was declared and rejected — not a did-you-mean', () => {
    const miss = report.findings.find((f) => isUnresolvedReferenceFinding(f) && f.targetId === 'conv.b');
    expect(miss).toBeDefined();
    expect(miss!.suggestedFix).toContain("'conv.b' is declared in node_modules/@r76/f1/conventions.ts but was rejected");
    expect(miss!.suggestedFix).toContain('severity');
    // The accepted sibling resolves.
    expect(report.findings.some((f) => isUnresolvedReferenceFinding(f) && f.targetId === 'conv.a')).toBe(false);
  });

  test('packs doctor: contribution-entries-rejected — 2 of 10 — with the satisfies / --typecheck pointer', () => {
    const issue = packDoctor.issues.find((i) => i.code === 'contribution-entries-rejected' && i.message.startsWith('conventions.ts'));
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('error');
    expect(issue!.message).toContain('2 of 10 entries rejected');
    expect(issue!.message).toContain("'conv.b'");
    expect(issue!.suggestion).toContain('satisfies IConvention[]');
    expect(issue!.suggestion).toContain('--typecheck');
    expect(issue!.suggestedCommand).toBe('shrk packs contributions --pack @r76/f1');
    expect(packDoctor.passed).toBe(false);
  });
});
