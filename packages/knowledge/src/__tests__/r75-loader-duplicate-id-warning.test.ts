/**
 * Round 11 §3.1 — a DIFFERENT object reusing an id used to be dropped
 * silently (only the first registered). The loader now says so, naming both
 * exports; the same object exported twice is still one entry, no warning.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TypeScriptKnowledgeLoader } from '../index.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function file(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'shrk-r75-dup-'));
  roots.push(dir);
  const p = join(dir, 'knowledge.ts');
  writeFileSync(p, body);
  return p;
}

const entry = (id: string, title: string): string =>
  `{ id: '${id}', title: '${title}', type: 'technical', priority: 'low', scope: [], tags: [], appliesWhen: [], content: '${title}' }`;

describe('TypeScriptKnowledgeLoader — duplicate ids', () => {
  test('two different objects with one id → one warning naming both exports; only the first registers', async () => {
    const p = file(`export const dupA = ${entry('dup.id', 'Dup from A')};\nexport const dupB = ${entry('dup.id', 'Dup from B')};\n`);
    const r = await new TypeScriptKnowledgeLoader().load(p);
    expect(r.entries.map((e) => e.title)).toEqual(['Dup from A']);
    const warnings = r.warnings.filter((w) => w.includes('duplicate id "dup.id"'));
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('export "dupB"');
    expect(warnings[0]).toContain('earlier export "dupA"');
    expect(warnings[0]).toContain(p);
  });

  test('two members of ONE array export are told apart by index ("default[2]" vs "default[0]")', async () => {
    const p = file(`export default [${entry('dup.id', 'First')}, ${entry('other.id', 'Other')}, ${entry('dup.id', 'Second')}];\n`);
    const r = await new TypeScriptKnowledgeLoader().load(p);
    expect(r.entries.map((e) => e.title)).toEqual(['First', 'Other']);
    const warning = r.warnings.find((w) => w.includes('duplicate id "dup.id"'));
    expect(warning).toContain('export "default[2]"');
    expect(warning).toContain('earlier export "default[0]"');
  });

  test('the same object exported twice (named + default array) is one entry and no warning', async () => {
    const p = file(`export const a = ${entry('same.id', 'Same')};\nexport default [a];\n`);
    const r = await new TypeScriptKnowledgeLoader().load(p);
    expect(r.entries.length).toBe(1);
    expect(r.warnings.some((w) => w.includes('duplicate id'))).toBe(false);
  });
});
