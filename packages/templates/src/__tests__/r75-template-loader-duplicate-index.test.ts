/**
 * Round 11 §3.1 (review fix) — the template loader's duplicate-id warning
 * names WHICH member of an array export shadows which: `default[2]` vs
 * `default[0]`, not `default` vs `default`. Separate named exports keep
 * their bare names.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTemplatesFromFile } from '../template-loader.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function file(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'shrk-r75-tdup-'));
  roots.push(dir);
  const p = join(dir, 'templates.ts');
  writeFileSync(p, body);
  return p;
}

const tpl = (id: string, name: string): string => `{ id: '${id}', name: '${name}', description: 'd', variables: [] }`;

describe('loadTemplatesFromFile — duplicate ids', () => {
  test('two members of one array export → the warning carries both indexes; only the first registers', async () => {
    const p = file(`export default [${tpl('dup', 'First')}, ${tpl('other', 'Other')}, ${tpl('dup', 'Second')}];\n`);
    const r = await loadTemplatesFromFile(p);
    expect(r.templates.map((t) => t.name)).toEqual(['First', 'Other']);
    const warning = r.warnings.find((w) => w.includes('duplicate id "dup"'));
    expect(warning).toContain('export "default[2]"');
    expect(warning).toContain('earlier export "default[0]"');
  });

  test('separate named exports keep their bare export names', async () => {
    const p = file(`export const a = ${tpl('dup', 'A')};\nexport const b = ${tpl('dup', 'B')};\n`);
    const r = await loadTemplatesFromFile(p);
    const warning = r.warnings.find((w) => w.includes('duplicate id "dup"'));
    expect(warning).toContain('export "b"');
    expect(warning).toContain('earlier export "a"');
  });
});
