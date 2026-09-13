/**
 * r78 — the Markdown knowledge loader splits frontmatter through THE split
 * (round 15 closing, A2).
 *
 * The loader carried its own delimiter regex (`FRONTMATTER_RE`, the last
 * exemption in the r78 one-frontmatter-parser lock). It never matched a
 * BOM-prefixed file, so that file's id, title and `references:` were ignored
 * and the entry loaded as `doc.<file>` with nothing checkable; and an opening
 * `---` with no closing line read as "no frontmatter", so the entry loaded
 * silently under its file-name id with the block as body text. It now reads
 * `splitFrontmatter` (@shrkcrft/core): a BOM / CRLF file reads like any other,
 * and an unterminated block is REFUSED through the loader's rejected channel,
 * with its reason — the decision-record reader's wording.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RejectionCause } from '@shrkcrft/core';
import { MarkdownKnowledgeLoader, unsupportedFrontmatterKeys } from '../index.ts';

const dir = mkdtempSync(join(tmpdir(), 'shrk-r78-mdsplit-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const UNTERMINATED = 'frontmatter: an opening --- line has no closing --- line';

async function load(name: string, text: string) {
  const file = join(dir, name);
  writeFileSync(file, text);
  const loaded = await new MarkdownKnowledgeLoader().load(file);
  return { file, entries: loaded.entries, warnings: loaded.warnings, rejected: loaded.rejected ?? [] };
}

describe('r78 Markdown knowledge — THE frontmatter split', () => {
  test('a BOM-prefixed file has its frontmatter read (it loaded as doc.<file> with nothing checkable)', async () => {
    const r = await load('bom.md', '\uFEFF---\nid: doc.bom-entry\ntitle: BOM entry\nreferences: [file:src/a.ts]\n---\n# Heading\n\nBody.\n');
    expect(r.rejected).toEqual([]);
    expect(r.entries.map((e) => ({ id: e.id, title: e.title, references: e.references }))).toEqual([
      { id: 'doc.bom-entry', title: 'BOM entry', references: [{ kind: 'file', path: 'src/a.ts' }] },
    ]);
    expect(r.entries[0]!.content).toBe('# Heading\n\nBody.');
  });

  test('a CRLF file reads the same, and its dropped key still warns', async () => {
    const r = await load('crlf.md', ['---', 'id: doc.crlf-entry', 'owner: me', '---', '# Crlf', '', 'Body.', ''].join('\r\n'));
    expect(r.entries.map((e) => e.id)).toEqual(['doc.crlf-entry']);
    expect(r.entries[0]!.content).not.toContain('\r');
    expect(r.warnings.some((w) => w.includes('frontmatter key "owner" was dropped'))).toBe(true);
    expect(unsupportedFrontmatterKeys('\uFEFF---\nid: x\nmetadata:\n  checks: []\n---\n').map((k) => k.key)).toEqual(['metadata']);
  });

  test('an unterminated block is REFUSED with its reason — never silently read as no frontmatter', async () => {
    const r = await load('unterminated.md', '---\nid: doc.unterm\ntitle: Unterminated\n\n# Body\n\nText.\n');
    // accepted + rejected = declared (one entry per Markdown file).
    expect(r.entries).toEqual([]);
    expect(r.rejected).toEqual([
      { file: r.file, index: -1, entryId: 'doc.unterminated', reasons: [UNTERMINATED], cause: RejectionCause.Invalid },
    ]);
  });

  test('only a `---` line closes the block — `---x` leaves it unterminated (the regex closed on it)', async () => {
    const r = await load('suffix.md', '---\nid: doc.suffix\n---x\nBody.\n');
    expect(r.entries).toEqual([]);
    expect(r.rejected.map((x) => x.reasons)).toEqual([[UNTERMINATED]]);
  });

  test('no opening delimiter: no frontmatter, the derived id, unchanged', async () => {
    const r = await load('plain-doc.md', '# Plain\n\nSome text.\n---\nA thematic break above.\n');
    expect(r.rejected).toEqual([]);
    expect(r.entries.map((e) => ({ id: e.id, title: e.title }))).toEqual([{ id: 'doc.plain-doc', title: 'Plain' }]);
  });

  test('a parse error still names the FILE line', async () => {
    const r = await load('stray.md', '---\nid: doc.stray\njust some text\n---\nBody.\n');
    expect(r.entries).toEqual([]);
    expect(r.rejected[0]!.reasons).toEqual(['frontmatter: Expected "<key>:" at line 3']);
  });
});
