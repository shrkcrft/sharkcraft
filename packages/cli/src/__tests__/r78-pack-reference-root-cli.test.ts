/**
 * r78 — pack reference roots end to end (round 15 follow-up, F7): the verbs a
 * consumer runs. A pack doc referencing a file the pack ships was STALE in every
 * consumer; `root: pack` verifies it, the unrooted spelling's hint names
 * `root: pack`, `root: pack` on a local entry is a `shrk doctor` error, and
 * `packs test --load` accepts it on a pack's entry.
 *
 * Real workspaces, a real pack under node_modules, the CLI from source.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts');
const T = 60_000;
const PACK = '@r78/rootpack';
const PACK_DIR = `node_modules/${PACK}`;
const roots: string[] = [];

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function shrk(cwd: string, argv: readonly string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync('bun', ['run', CLI_MAIN, '--no-hints', ...argv], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

const LOCAL_OK =
  "export default [{ id: 'k.one', title: 'One', type: 'technical', priority: 'medium', scope: [], tags: [], appliesWhen: [], content: 'x', references: [{ kind: 'file', path: 'src/a.ts' }] }];\n";

/** A git-initialised consumer with one verified local entry, a pack shipping `packFiles`, and `extra` files. */
function workspace(packFiles: Record<string, string>, contributions: Record<string, readonly string[]>, extra: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r78-packroot-cli-'));
  roots.push(root);
  const all: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'r78-packroot-cli', version: '0.0.0', private: true }),
    'src/a.ts': 'export class Foo {}\n',
    'sharkcraft/knowledge.ts': LOCAL_OK,
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'r78-packroot-cli', knowledgeFiles: ['knowledge.ts'] };\n",
    [`${PACK_DIR}/package.json`]: JSON.stringify({ name: PACK, version: '0.0.1', sharkcraft: { manifest: './manifest.json' } }),
    [`${PACK_DIR}/manifest.json`]: JSON.stringify({ schema: 'sharkcraft.pack/v1', info: { name: PACK, version: '0.0.1' }, contributions }),
    ...Object.fromEntries(Object.entries(packFiles).map(([rel, body]) => [`${PACK_DIR}/${rel}`, body])),
    ...extra,
  };
  for (const [rel, body] of Object.entries(all)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  spawnSync('git', ['init', '-q'], { cwd: root });
  return root;
}

function md(frontmatter: string): string {
  return `---\n${frontmatter}\n---\n# Guide\n\nAbout the pack.\n`;
}

describe('r78 a pack doc referencing the pack’s own file (the round-15 repro)', () => {
  test(
    'without root: STALE (exit 1) — the row names the .md and the hint names root: pack',
    () => {
      const root = workspace({ 'docs/guide.md': md('id: pack.guide\nreferences: [file:docs/guide.md]') }, { docsFiles: ['./docs/guide.md'] });
      const s = shrk(root, ['knowledge', 'stale-check']);
      expect(s.status).toBe(1);
      const lines = s.stdout.split('\n');
      const i = lines.findIndex((l) => l.includes('pack.guide → file:docs/guide.md'));
      expect(lines[i]).toContain('STALE');
      expect(lines[i]).toContain(`(${PACK_DIR}/docs/guide.md)`);
      expect(lines[i + 1]).toContain(`docs/guide.md is shipped inside pack ${PACK}`);
      expect(lines[i + 1]).toContain('declare root: pack');
    },
    T,
  );

  test(
    'with root: pack on the map item: verified, exit 0',
    () => {
      const root = workspace(
        { 'docs/guide.md': md('id: pack.guide\nreferences:\n  - kind: file\n    path: docs/guide.md\n    root: pack') },
        { docsFiles: ['./docs/guide.md'] },
      );
      const s = shrk(root, ['knowledge', 'stale-check']);
      expect(s.status).toBe(0);
      expect(s.stdout).toContain('2 of 2 knowledge entries verified');
      // The listing verb names the root in text, as its --json carries it (they used to disagree).
      const refs = shrk(root, ['knowledge', 'references', 'pack.guide']);
      expect(refs.status).toBe(0);
      expect(refs.stdout).toContain('• file: docs/guide.md [root: pack]');
      const refsJson = shrk(root, ['knowledge', 'references', 'pack.guide', '--json']);
      expect(JSON.parse(refsJson.stdout).references).toEqual([{ kind: 'file', path: 'docs/guide.md', root: 'pack' }]);
    },
    T,
  );

  test(
    'a stale pack-rooted row shows the root it resolved against',
    () => {
      const root = workspace(
        { 'docs/guide.md': md('id: pack.guide\nreferences:\n  - kind: file\n    path: docs/gone.md\n    root: pack') },
        { docsFiles: ['./docs/guide.md'] },
      );
      const s = shrk(root, ['knowledge', 'stale-check']);
      expect(s.status).toBe(1);
      const row = s.stdout.split('\n').find((l) => l.includes('pack.guide → file:docs/gone.md'));
      expect(row).toContain(`File missing: docs/gone.md (root: pack — ${PACK} at ${PACK_DIR})`);
    },
    T,
  );
});

describe('r78 root: pack on a local entry is refused on every surface', () => {
  const localRootPack =
    "export default [{ id: 'k.one', title: 'One', type: 'technical', priority: 'medium', scope: [], tags: [], appliesWhen: [], content: 'x', references: [{ kind: 'file', path: 'src/a.ts', root: 'pack' }] }];\n";

  test(
    'doctor: a knowledge validation error; stale-check: INVALID (2 by default, 1 under --fail-on invalid)',
    () => {
      const root = workspace({}, {}, { 'sharkcraft/knowledge.ts': localRootPack });
      const d = shrk(root, ['doctor']);
      expect(d.stdout + d.stderr).toContain('sets root: pack, but no pack contributes this entry');
      // An error-severity validation issue: the doctor fails (it is not a warning to scroll past).
      expect(d.status).toBe(1);
      const s = shrk(root, ['knowledge', 'stale-check']);
      expect(s.status).toBe(2);
      const f = shrk(root, ['knowledge', 'stale-check', '--fail-on', 'invalid']);
      expect(f.status).toBe(1);
      expect(f.stdout).toContain('sets root: pack, but no pack contributes this entry');
    },
    T,
  );
});

describe('r78 packs test --load accepts root: pack on a pack’s entry', () => {
  test(
    'a pack whose TS and Markdown entries declare root: pack loads clean (exit 0)',
    () => {
      const root = workspace(
        {
          'docs/guide.md': md('id: pack.guide\nreferences:\n  - kind: file\n    path: docs/guide.md\n    root: pack'),
          'knowledge.ts':
            "export default [{ id: 'pack.k', title: 'K', type: 'technical', priority: 'medium', scope: [], tags: [], appliesWhen: [], content: 'x', references: [{ kind: 'file', path: 'docs/guide.md', root: 'pack' }] }];\n",
        },
        { docsFiles: ['./docs/guide.md'], knowledgeFiles: ['./knowledge.ts'] },
      );
      const t = shrk(root, ['packs', 'test', PACK_DIR, '--load']);
      expect(t.stdout + t.stderr).not.toContain('root: pack');
      expect(t.status).toBe(0);
    },
    T,
  );
});
