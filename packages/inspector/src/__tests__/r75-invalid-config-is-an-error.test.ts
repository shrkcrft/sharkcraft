import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DoctorSeverity } from '../doctor-result.ts';
import { resolveProjectConfig } from '../resolve-project-config.ts';
import { inspectSharkcraft, runDoctor } from '../sharkcraft-inspector.ts';

/**
 * An invalid sharkcraft.config.ts is discarded WHOLE — every config-declared
 * setting and plane goes with it. Doctor used to report that as two warnings
 * ("Invalid sharkcraft.config.ts: …" AND "No config file detected — using
 * defaults", a contradiction) with "0 errors", so it looked green. It is an
 * error that names the file and the schema issues, and a file that exists is
 * never reported as missing.
 */

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function makeProject(configBody: string | null): string {
  const root = mkdtempSync(join(tmpdir(), 'sc-r75-badcfg-'));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'r75-badcfg', version: '0.0.0', private: true }));
  const sc = join(root, 'sharkcraft');
  mkdirSync(sc);
  if (configBody !== null) writeFileSync(join(sc, 'sharkcraft.config.ts'), configBody);
  return root;
}

const NO_CONFIG_MESSAGE = 'No config file detected';
const CONFIG_REL = join('sharkcraft', 'sharkcraft.config.ts');

describe('an invalid config is a doctor ERROR', () => {
  test('unrecognized keys: error-severity finding naming the file and the issues', async () => {
    const root = makeProject(`export default {
  projectName: 'r75-badcfg',
  notARealKey: true,
};
`);
    const inspection = await inspectSharkcraft({ cwd: root });
    expect(inspection.config).toBeNull();
    expect(inspection.configLoadError).toBeDefined();
    expect(inspection.configLoadError?.file?.endsWith(CONFIG_REL)).toBe(true);
    expect(inspection.configLoadError?.issues.join('\n')).toContain('notARealKey');

    const result = runDoctor(inspection);
    const configErrors = result.checks.filter(
      (c) => c.severity === DoctorSeverity.Error && c.category === 'config-invalid',
    );
    expect(configErrors).toHaveLength(1);
    const finding = configErrors[0]!;
    expect(finding.id).toBe('config');
    expect(finding.message).toContain(CONFIG_REL);
    expect(finding.message).toContain('notARealKey');

    // The file exists, so doctor never also claims it is missing.
    expect(result.checks.some((c) => c.message.includes(NO_CONFIG_MESSAGE))).toBe(false);
    // The same failure is not repeated as a second, weaker loader warning.
    expect(
      result.checks.some(
        (c) => c.severity === DoctorSeverity.Warning && c.message === inspection.configLoadError?.message,
      ),
    ).toBe(false);
    expect(result.summary.errors).toBeGreaterThanOrEqual(1);
    expect(result.passed).toBe(false);
  }, 30_000);

  test('a config that fails to BUILD is an error too, and a second load settles', async () => {
    const root = makeProject("export default { projectName: 'r75-badcfg', tags: ['a' 'b'] };\n");
    const inspection = await inspectSharkcraft({ cwd: root });
    expect(inspection.config).toBeNull();
    expect(inspection.configLoadError?.file?.endsWith(CONFIG_REL)).toBe(true);
    expect(inspection.configLoadError?.issues.length).toBeGreaterThan(0);

    const result = runDoctor(inspection);
    const finding = result.checks.find((c) => c.id === 'config');
    expect(finding?.severity).toBe(DoctorSeverity.Error);
    expect(finding?.category).toBe('config-invalid');
    expect(result.checks.some((c) => c.message.includes(NO_CONFIG_MESSAGE))).toBe(false);
    expect(result.summary.errors).toBeGreaterThanOrEqual(1);

    // The inspection already imported the broken config once. Re-loading it in
    // the same process used to hang forever (the verb exited 0, silently); it
    // must settle as a load error instead.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      resolveProjectConfig(root).then((r) => (r.ok ? 'loaded' : 'error')),
      new Promise<'pending'>((resolve) => {
        timer = setTimeout(() => resolve('pending'), 2000);
      }),
    ]);
    if (timer) clearTimeout(timer);
    expect(outcome).toBe('error');
  }, 30_000);

  test('control: a valid config is loaded and reported OK', async () => {
    const root = makeProject(`export default { projectName: 'r75-goodcfg' };\n`);
    const inspection = await inspectSharkcraft({ cwd: root });
    expect(inspection.configLoadError).toBeUndefined();
    expect(inspection.config).not.toBeNull();
    const finding = runDoctor(inspection).checks.find((c) => c.id === 'config');
    expect(finding?.severity).toBe(DoctorSeverity.Ok);
    expect(finding?.message).toContain('Loaded from');
  }, 30_000);

  test('control: a sharkcraft/ folder with NO config file still reports defaults', async () => {
    const root = makeProject(null);
    const inspection = await inspectSharkcraft({ cwd: root });
    expect(inspection.configLoadError).toBeUndefined();
    const finding = runDoctor(inspection).checks.find((c) => c.id === 'config');
    expect(finding?.severity).toBe(DoctorSeverity.Warning);
    expect(finding?.message).toContain(NO_CONFIG_MESSAGE);
  }, 30_000);
});
