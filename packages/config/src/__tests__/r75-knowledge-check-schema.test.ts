/**
 * Round 11, 1.2#4 — the documented `knowledgeCheck` block loads through the
 * strict config schema (it used to be rejected as an unrecognized key, which
 * silently emptied every knowledge verb), including the round-11 keys
 * `minReferenced` / `requireReferences` and the widened `failOn` vocabulary.
 * The inner object stays `.strict()`: an unknown nested key still fails.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProjectConfig } from '../config-loader.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function fixture(knowledgeCheck: string): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-kcheck-'));
  roots.push(root);
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'kc', version: '0.0.0' }));
  writeFileSync(
    join(root, 'sharkcraft', 'sharkcraft.config.ts'),
    `export default { projectName: 'kc', knowledgeCheck: ${knowledgeCheck} };\n`,
  );
  return root;
}

describe('knowledgeCheck', () => {
  test('the documented block — with the round-11 keys — loads', async () => {
    const r = await loadProjectConfig(
      fixture(
        "{ enabled: true, strict: false, failOn: ['required', 'unverifiable', 'count'], minReferenced: 0.8, requireReferences: true }",
      ),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.config.knowledgeCheck).toEqual({
        enabled: true,
        strict: false,
        failOn: ['required', 'unverifiable', 'count'],
        minReferenced: 0.8,
        requireReferences: true,
      });
    }
  });

  test('an unknown nested key is still rejected (the inner object is strict)', async () => {
    const r = await loadProjectConfig(fixture('{ enabled: true, bogus: 1 }'));
    expect(r.ok).toBe(false);
  });

  test('a floor outside 0..1 and an unknown failOn category are rejected', async () => {
    expect((await loadProjectConfig(fixture('{ minReferenced: 1.5 }'))).ok).toBe(false);
    expect((await loadProjectConfig(fixture("{ failOn: ['bogus'] }"))).ok).toBe(false);
  });
});
