/**
 * Round 11 §4.6 — the Markdown loader parsed EVERY frontmatter key and then
 * built the entry from a fixed field list, so `metadata` (and any other key)
 * vanished without a word: a Markdown rule `rules list` shows can never carry
 * `metadata.checks[]`, and nothing said so. Each dropped key now warns; the
 * entry itself is unchanged (byte-identical to the same file without them).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarkdownKnowledgeLoader, unsupportedFrontmatterKeys } from '../index.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function md(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'shrk-r75-md-'));
  roots.push(dir);
  const p = join(dir, 'rule.md');
  writeFileSync(p, body);
  return p;
}

const WITH_EXTRA =
  '---\nid: md.rule\ntitle: MD rule\ntype: rule\nowner: team-a\n' +
  'metadata: {"checks": [{"id": "md-check", "command": "echo"}]}\ntags: [a, b]\n---\n# MD rule\n\nBody.\n';
const WITHOUT = '---\nid: md.rule\ntitle: MD rule\ntype: rule\ntags: [a, b]\n---\n# MD rule\n\nBody.\n';

describe('MarkdownKnowledgeLoader — dropped frontmatter keys', () => {
  test('each unsupported key warns; metadata names the TypeScript remedy', async () => {
    const p = md(WITH_EXTRA);
    const r = await new MarkdownKnowledgeLoader().load(p);
    expect(r.warnings.length).toBe(2);
    const owner = r.warnings.find((w) => w.includes('"owner"'));
    const metadata = r.warnings.find((w) => w.includes('"metadata"'));
    expect(owner).toContain(`${p}: frontmatter key "owner" was dropped`);
    expect(metadata).toContain('the Markdown loader does not support metadata');
    expect(metadata).toContain('TypeScript rule file');
  });

  test('the produced entry is byte-identical to the same file without the dropped keys', async () => {
    const a = (await new MarkdownKnowledgeLoader().load(md(WITH_EXTRA))).entries[0]!;
    const b = (await new MarkdownKnowledgeLoader().load(md(WITHOUT))).entries[0]!;
    const strip = (e: typeof a): string => JSON.stringify({ ...e, source: undefined });
    expect(strip(a)).toBe(strip(b));
    expect((await new MarkdownKnowledgeLoader().load(md(WITHOUT))).warnings).toEqual([]);
  });
});

describe('unsupportedFrontmatterKeys — THE "what did the loader drop" answer', () => {
  test('a multi-line block belongs to its key; supported keys (both spellings) are never listed', () => {
    const text =
      '---\nid: x\nsee-also: [a]\nsupersededBy: [b]\nmetadata:\n  checks:\n    - id: a\nextra: 1\n---\nbody\n';
    expect(unsupportedFrontmatterKeys(text)).toEqual([
      { key: 'metadata', block: 'metadata:\n  checks:\n    - id: a' },
      { key: 'extra', block: 'extra: 1' },
    ]);
  });

  test('no frontmatter → nothing dropped', () => {
    expect(unsupportedFrontmatterKeys('# Just a doc\n')).toEqual([]);
  });
});
