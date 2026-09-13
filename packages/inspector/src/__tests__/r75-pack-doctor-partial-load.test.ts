/**
 * Round 11 §1.4#a (6) + §3.3#1 — the pack doctor no longer passes a pack whose
 * contributions did not load: one broken file among good ones, a file that
 * loaded but produced nothing, and a compiled build older than its source are
 * each an issue. `k=2 / entries=1` used to be printed and never compared.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildPackDoctorReportAsync, inspectSharkcraft } from '../index.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function write(root: string, rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

const entry = (id: string, content = 'ok'): string =>
  `{ id: '${id}', title: '${id}', type: 'technical', priority: 'low', scope: [], tags: [], appliesWhen: [], content: '${content}' }`;

function consumer(files: Record<string, string>, contributions: Record<string, readonly string[]>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-pdoc-'));
  roots.push(root);
  write(root, 'package.json', JSON.stringify({ name: 'consumer', version: '0.0.0' }));
  write(root, 'sharkcraft/sharkcraft.config.ts', "export default { projectName: 'consumer' };\n");
  const pack = join(root, 'node_modules', '@r75', 'pdoc');
  write(pack, 'package.json', JSON.stringify({ name: '@r75/pdoc', version: '0.0.1', sharkcraft: { manifest: './manifest.json' } }));
  write(
    pack,
    'manifest.json',
    JSON.stringify({ schema: 'sharkcraft.pack/v1', info: { name: '@r75/pdoc', version: '0.0.1' }, contributions }),
  );
  for (const [rel, body] of Object.entries(files)) write(pack, rel, body);
  return root;
}

describe('pack doctor — partial loads', () => {
  test('one good + one broken knowledge file → contribution-load-failed (error), verdict not OK', async () => {
    const root = consumer(
      {
        'k-good.ts': `export default [${entry('pack.good')}];\n`,
        'k-broken.ts': `export default [{ id: 'pack.broken', tags: ['a' 'b'] }];\n`,
      },
      { knowledgeFiles: ['./k-good.ts', './k-broken.ts'] },
    );
    const report = await buildPackDoctorReportAsync(await inspectSharkcraft({ cwd: root }));
    const failed = report.issues.filter((i) => i.code === 'contribution-load-failed');
    expect(failed.length).toBe(1);
    expect(failed[0]!.severity).toBe('error');
    expect(failed[0]!.message).toContain('k-broken.ts');
    expect(report.passed).toBe(false);
  });

  test('a declared file that loads but produces no entry → partially-resolved-contributions (warning)', async () => {
    const root = consumer(
      {
        'k-good.ts': `export default [${entry('pack.good')}];\n`,
        'k-empty.ts': 'export const notAnEntry = 1;\n',
      },
      { knowledgeFiles: ['./k-good.ts', './k-empty.ts'] },
    );
    const report = await buildPackDoctorReportAsync(await inspectSharkcraft({ cwd: root }));
    const partial = report.issues.find((i) => i.code === 'partially-resolved-contributions');
    expect(partial?.severity).toBe('warning');
    expect(partial?.message).toContain('1 of 2');
    expect(partial?.message).toContain('k-empty.ts');
  });

  test('a compiled build older than its source → compiled-artifacts-stale (warning; error under --strict)', async () => {
    const src = `export default [${entry('pack.rule', 'NEW')}];\n`;
    const files = {
      'dist/rules.js': `export default [${entry('pack.rule', 'OLD')}];\n`,
      'dist/rules.js.map': JSON.stringify({ version: 3, sources: ['../src/rules.ts'], sourcesContent: ['an older source'], mappings: '' }),
      'src/rules.ts': src,
    };
    const root = consumer(files, { ruleFiles: ['./dist/rules.js'] });
    const inspection = await inspectSharkcraft({ cwd: root });
    const plain = await buildPackDoctorReportAsync(inspection);
    expect(plain.issues.find((i) => i.code === 'compiled-artifacts-stale')?.severity).toBe('warning');
    const strict = await buildPackDoctorReportAsync(inspection, { strict: true });
    expect(strict.issues.find((i) => i.code === 'compiled-artifacts-stale')?.severity).toBe('error');
    expect(strict.passed).toBe(false);
  });
});
