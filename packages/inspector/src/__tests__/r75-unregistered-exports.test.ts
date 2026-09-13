/**
 * Round 11 §3.1 — an entry a group module exports that the aggregator never
 * registers is silently invisible. `detectUnregisteredExports` diffs the
 * aggregator's direct relative imports against what the registries hold,
 * with the loader's OWN entry predicate.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { buildPackDoctorReportAsync, detectUnregisteredExports, inspectSharkcraft } from '../index.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function write(root: string, rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

const entry = (id: string): string =>
  `{ id: '${id}', title: '${id}', type: 'technical', priority: 'low', scope: [], tags: [], appliesWhen: [], content: '${id}' }`;

const GROUP_A = `export const a1 = ${entry('a.one')};\nexport const a2 = ${entry('a.two')};\n`;
const GROUP_B = `export const b1 = ${entry('b.one')};\n`;
const HAND_LIST = `import { a1 } from './group-a.ts';\nimport { b1 } from './group-b.ts';\nexport default [a1, b1];\n`;
const RE_EXPORT = `export * from './group-a.ts';\nexport * from './group-b.ts';\n`;

function local(aggregator: string): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-unreg-'));
  roots.push(root);
  write(root, 'package.json', JSON.stringify({ name: 'u', version: '0.0.0' }));
  write(root, 'sharkcraft/sharkcraft.config.ts', "export default { projectName: 'u', knowledgeFiles: ['knowledge/index.ts'] };\n");
  write(root, 'sharkcraft/knowledge/group-a.ts', GROUP_A);
  write(root, 'sharkcraft/knowledge/group-b.ts', GROUP_B);
  write(root, 'sharkcraft/knowledge/index.ts', aggregator);
  return root;
}

describe('detectUnregisteredExports', () => {
  test('a hand-maintained aggregator: exactly one finding — a.two, located in group-a.ts', async () => {
    const root = local(HAND_LIST);
    const inspection = await inspectSharkcraft({ cwd: root });
    const found = await detectUnregisteredExports(inspection);
    expect(found).toEqual([
      expect.objectContaining({
        kind: 'knowledge',
        id: 'a.two',
        exportName: 'a2',
        group: 'sharkcraft/knowledge/group-a.ts',
        aggregator: 'sharkcraft/knowledge/index.ts',
        line: 2,
      }),
    ]);
    expect(found[0]!.message).toContain("export * from './group-a.ts'");
  });

  test('`export * from` registers the whole group — zero findings, and the entry is listed', async () => {
    const root = local(RE_EXPORT);
    const inspection = await inspectSharkcraft({ cwd: root });
    expect(await detectUnregisteredExports(inspection)).toEqual([]);
    expect(inspection.knowledgeEntries.map((e) => e.id).sort()).toEqual(['a.one', 'a.two', 'b.one']);
  });

  test('list ≡ check: the ids treated as registered are exactly what the loader registered from that file', async () => {
    const root = local(HAND_LIST);
    const inspection = await inspectSharkcraft({ cwd: root });
    const aggregator = resolve(root, 'sharkcraft/knowledge/index.ts');
    const listed = inspection.knowledgeEntries.filter((e) => e.source?.origin === aggregator).map((e) => e.id).sort();
    expect(listed).toEqual(['a.one', 'b.one']);
    const exported = ['a.one', 'a.two', 'b.one'];
    const flagged = (await detectUnregisteredExports(inspection)).map((u) => u.id);
    expect(flagged).toEqual(exported.filter((id) => !listed.includes(id)));
  });

  test('a pack aggregator: the same finding, attributed to the pack, and packs doctor reports it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-r75-unreg-pack-'));
    roots.push(root);
    write(root, 'package.json', JSON.stringify({ name: 'consumer', version: '0.0.0' }));
    write(root, 'sharkcraft/sharkcraft.config.ts', "export default { projectName: 'consumer' };\n");
    const pack = join(root, 'node_modules', '@r75', 'agg');
    write(pack, 'package.json', JSON.stringify({ name: '@r75/agg', version: '0.0.1', sharkcraft: { manifest: './manifest.json' } }));
    write(
      pack,
      'manifest.json',
      JSON.stringify({
        schema: 'sharkcraft.pack/v1',
        info: { name: '@r75/agg', version: '0.0.1' },
        contributions: { knowledgeFiles: ['./knowledge/index.ts'] },
      }),
    );
    write(pack, 'knowledge/group-a.ts', GROUP_A);
    write(pack, 'knowledge/group-b.ts', GROUP_B);
    write(pack, 'knowledge/index.ts', HAND_LIST);
    const inspection = await inspectSharkcraft({ cwd: root });
    const found = await detectUnregisteredExports(inspection);
    expect(found.map((u) => ({ id: u.id, packageName: u.packageName }))).toEqual([{ id: 'a.two', packageName: '@r75/agg' }]);
    const report = await buildPackDoctorReportAsync(inspection);
    const issue = report.issues.find((i) => i.code === 'unregistered-export');
    expect(issue?.severity).toBe('error');
    expect(issue?.message).toContain('a.two');
  });
});
