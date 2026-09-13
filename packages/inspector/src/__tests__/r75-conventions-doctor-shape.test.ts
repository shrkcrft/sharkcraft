/**
 * Round 11 §3.2 — through the REAL convention registry (a temp workspace, the
 * real config loader, the real inspector): a convention whose reference kind is
 * outside the vocabulary, or whose severity no verdict can fail on, is dropped
 * with an `invalid-convention` error naming the allowed values; a shape warning
 * (an unknown key) keeps the convention and reports `convention-shape`; and the
 * load reports which convention FILES it read — the doctor's coverage.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadConventions } from '../convention-registry.ts';
import { inspectSharkcraft } from '../sharkcraft-inspector.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function workspace(config: string, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-conv-'));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0' }));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  writeFileSync(join(root, 'sharkcraft', 'sharkcraft.config.ts'), `export default { projectName: 'fx'${config ? `, ${config}` : ''} };\n`);
  return root;
}

const CONVENTIONS =
  'export default [\n' +
  "  { id: 'c.ok', title: 'Ok', kind: 'naming', severity: 'warning', rules: [], owner: 'team-a' },\n" +
  "  { id: 'c.bad-ref', title: 'Bad ref', kind: 'naming', severity: 'warning', rules: [], references: [{ kind: 'not-a-real-kind', value: 'v' }] },\n" +
  "  { id: 'c.critical', title: 'Critical', kind: 'naming', severity: 'critical', rules: [] },\n" +
  '];\n';

describe('loadConventions — closed unions, shape warnings, file coverage', () => {
  test('bad reference kind / severity are dropped loudly; an unknown key is a convention-shape warning', async () => {
    const insp = await inspectSharkcraft({ cwd: workspace('', { 'sharkcraft/conventions.ts': CONVENTIONS }) });
    const { entries, issues, files } = await loadConventions(insp);
    expect(entries.map((e) => e.convention.id)).toEqual(['c.ok']);
    const shape = issues.filter((i) => i.code === 'convention-shape');
    expect(shape.map((i) => [i.severity, i.conventionId])).toEqual([['warning', 'c.ok']]);
    expect(shape[0]?.message).toContain('unknown key "owner"');
    const invalid = issues.filter((i) => i.code === 'invalid-convention');
    expect(invalid.map((i) => i.conventionId).sort()).toEqual(['c.bad-ref', 'c.critical']);
    expect(invalid.find((i) => i.conventionId === 'c.bad-ref')?.message).toContain(
      'expected one of: file, doc, command, knowledge, rule',
    );
    expect(invalid.find((i) => i.conventionId === 'c.critical')?.message).toContain('info, warning, error');
    expect(files).toEqual({ discovered: 1, unread: [] });
  });

  test('a declared convention file that does not load is discovered but unread', async () => {
    const insp = await inspectSharkcraft({
      cwd: workspace("conventionFiles: ['missing.ts']", {}),
    });
    const { files, issues } = await loadConventions(insp);
    expect(files.discovered).toBe(1);
    expect(files.unread).toEqual(['sharkcraft/missing.ts — failed to load']);
    expect(issues.map((i) => i.code)).toEqual(['load-failed']);
  });

  test('no convention file at all → nothing discovered', async () => {
    const insp = await inspectSharkcraft({ cwd: workspace('', {}) });
    expect((await loadConventions(insp)).files).toEqual({ discovered: 0, unread: [] });
  });
});
