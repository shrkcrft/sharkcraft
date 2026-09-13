/**
 * r78 — `packs test --load` reads a contribution file the way the consumer
 * reads its SLOT, never by its extension alone (round 15 follow-up, F11).
 *
 * Before: "Markdown knowledge" was decided by `/\.md$/`:
 *
 *   - a knowledge-slot file no knowledge loader reads (`knowledgeFiles:
 *     ['./notes.txt']`) was skipped in silence — "No issues found" — while the
 *     consumer skips it as an "unsupported contribution file": nothing in it
 *     takes effect;
 *   - a `.md` under a MODULE slot (`templateFiles: ['./README.md']`) was run
 *     through that slot's loader but only its rejections were read — the
 *     consumer imports it as a template module that exports no templates;
 *   - a pack of Markdown knowledge alone had "no importable contribution file",
 *     so `--load` settled NOT VERIFIED (2) over files it had in fact validated.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts');
const T = 60_000;
const roots: string[] = [];

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function pack(name: string, contributions: Record<string, readonly string[]>, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r78-slot-'));
  roots.push(root);
  const all: Record<string, string> = {
    'package.json': JSON.stringify({ name, version: '0.0.1', sharkcraft: { manifest: './manifest.json' } }),
    'manifest.json': JSON.stringify({ schema: 'sharkcraft.pack/v1', info: { name, version: '0.0.1' }, contributions }),
    ...files,
  };
  for (const [rel, body] of Object.entries(all)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

interface IPackTest {
  readonly exitCode: number;
  readonly issues: readonly { code: string; message: string; severity: string }[];
  readonly modules: readonly { relativePath: string; kind: string; loaded: boolean; accepted?: number; rejected?: number }[];
}

function packsTestLoad(root: string): { status: number; out: IPackTest } {
  const res = spawnSync('bun', ['run', CLI_MAIN, '--no-hints', 'packs', 'test', '.', '--load', '--json'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  return { status: res.status ?? -1, out: JSON.parse(res.stdout ?? '') as IPackTest };
}

describe('r78 F11 — the slot decides, not the extension', () => {
  test(
    'a knowledge-slot file no knowledge loader reads is an asset-unsupported ERROR; its Markdown sibling is read by the Markdown loader',
    () => {
      const root = pack('@r78/slot-a', { knowledgeFiles: ['./notes.txt', './guide.md'] }, {
        'notes.txt': 'plain text, not knowledge\n',
        // A BLOCK list: an inline `title: [A, B]` is the title text since round 15 closing.
        'guide.md': '---\nid: p.guide\ntitle:\n  - A\n  - B\n---\n# Guide\n',
      });
      const { status, out } = packsTestLoad(root);
      expect(status).toBe(1);
      const unsupported = out.issues.find((i) => i.code === 'asset-unsupported');
      expect(unsupported?.severity).toBe('error');
      expect(unsupported?.message).toContain('notes.txt is declared under knowledgeFiles');
      // Read by the Markdown loader: its refused entry is named.
      const rejected = out.issues.find((i) => i.code === 'asset-entry-rejected' && i.message.startsWith('guide.md '));
      expect(rejected?.message).toContain('title: must be a single value (got a list)');
      expect(out.modules.find((m) => m.relativePath === 'guide.md')).toMatchObject({ kind: 'knowledge', loaded: true, accepted: 0, rejected: 1 });
    },
    T,
  );

  test(
    'a .md under a MODULE slot is read like its runtime loader reads it (imported), never as Markdown knowledge',
    () => {
      const root = pack('@r78/slot-b', { templateFiles: ['./README.md'] }, { 'README.md': '# Readme\n' });
      const { status, out } = packsTestLoad(root);
      expect(status).toBe(1);
      const readme = out.issues.filter((i) => i.message.startsWith('README.md'));
      expect(readme.length).toBeGreaterThan(0);
      expect(readme.every((i) => !i.message.includes('knowledge loader'))).toBe(true);
      expect(out.modules.find((m) => m.relativePath === 'README.md')?.kind).toBe('template');
    },
    T,
  );

  test(
    'the knowledge loader decides, not an importable-looking name: a .mts / .cts under knowledgeFiles is asset-unsupported (the consumer skips both)',
    () => {
      const entry = (id: string): string =>
        `export default [{ id: '${id}', title: 'T', type: 'technical', priority: 'low', scope: [], tags: [], appliesWhen: [], content: 'x' }];\n`;
      const root = pack('@r78/slot-d', { knowledgeFiles: ['./k.mts', './k2.cts', './k3.ts'] }, {
        'k.mts': entry('p.m'),
        'k2.cts': entry('p.c'),
        'k3.ts': entry('p.t'),
      });
      const { status, out } = packsTestLoad(root);
      expect(status).toBe(1);
      const unsupported = out.issues.filter((i) => i.code === 'asset-unsupported');
      expect(unsupported.map((i) => [i.severity, i.message.split(' ')[0]])).toEqual([
        ['error', 'k.mts'],
        ['error', 'k2.cts'],
      ]);
      expect(unsupported[0]!.message).toContain('no knowledge loader reads a `.mts` file');
      expect(out.modules.find((m) => m.relativePath === 'k.mts')).toMatchObject({ loaded: false });
      // A `.ts` the TypeScript knowledge loader reads is still imported and validated.
      expect(out.modules.find((m) => m.relativePath === 'k3.ts')).toMatchObject({ kind: 'knowledge', loaded: true, accepted: 1, rejected: 0 });
    },
    T,
  );

  test(
    'a pack of Markdown knowledge alone is examined — exit 0, never "nothing importable" (it was NOT VERIFIED, 2)',
    () => {
      const root = pack('@r78/slot-c', { docsFiles: ['./guide.md'] }, { 'guide.md': '---\nid: p.doc\ntitle: Guide\n---\n# Guide\n' });
      const { status, out } = packsTestLoad(root);
      expect(status).toBe(0);
      expect(out.exitCode).toBe(0);
      expect(out.modules).toEqual([{ relativePath: 'guide.md', kind: 'docsFiles', loaded: true, accepted: 1, rejected: 0 }]);
    },
    T,
  );
});
