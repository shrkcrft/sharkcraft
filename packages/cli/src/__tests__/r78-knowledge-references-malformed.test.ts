/**
 * r78 — malformed knowledge references take ONE path, whatever the format
 * (round 15, 15.2).
 *
 *   - A shape-invalid item (unknown kind, …) is INVALID in the stale-check and
 *     `invalid-reference` in the doctor — a Markdown item exactly like the
 *     TypeScript literal.
 *   - A NON-LIST `references` value (TS or Markdown) crashed every
 *     inspection-backed verb (`(entry.references ?? []).forEach is not a
 *     function`) — a pack shipping one crashed the consumer's `doctor` — while
 *     `packs test --load` said "No issues found". It is now a validation issue
 *     that keeps the entry, and `--load` reports it.
 *   - `fix --knowledge-stale --apply` refuses a Markdown entry loudly.
 *   - The `shrk init` seed passes its own stale-check and quality.
 *
 * Real workspaces and packs, the CLI from source.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts');
const T = 60_000;
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

function tree(prefix: string, files: Record<string, string>, git = true): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  if (git) spawnSync('git', ['init', '-q'], { cwd: root });
  return root;
}

function entry(id: string, references: string): string {
  return `{ id: '${id}', title: '${id}', type: 'technical', priority: 'medium', scope: [], tags: [], appliesWhen: [], content: 'About ${id}.', references: ${references} }`;
}

const BASE = {
  'package.json': JSON.stringify({ name: 'r78-bad', version: '0.0.0', private: true }),
  'src/a.ts': 'export const A = 1;\n',
};

function config(knowledgeFiles: readonly string[]): string {
  return `export default { projectName: 'r78-bad', knowledgeFiles: ${JSON.stringify(knowledgeFiles)} };\n`;
}

/** The INVALID row for `id`, without the declaring-file suffix. */
function invalidRow(stdout: string, id: string): string | undefined {
  return stdout
    .split('\n')
    .find((l) => l.includes('INVALID') && l.includes(`${id} →`))
    ?.replace(/\s+\([^)]*\)$/, '')
    .trim();
}

describe('r78 a shape-invalid item: INVALID + invalid-reference, Markdown exactly like TypeScript', () => {
  test(
    'unknown kind in an .md map and in a TS literal → the same INVALID row (exit 2) and doctor ERR invalid-reference (exit 1)',
    () => {
      const mdRoot = tree('shrk-r78-inv-md-', {
        ...BASE,
        'sharkcraft/guide.md': '---\nid: doc.guide\nreferences:\n  - kind: bogus\n    path: src/a.ts\n---\n# Guide\n',
        'sharkcraft/sharkcraft.config.ts': config(['guide.md']),
      });
      const tsRoot = tree('shrk-r78-inv-ts-', {
        ...BASE,
        'sharkcraft/knowledge.ts': `export default [${entry('doc.guide', "[{ kind: 'bogus', path: 'src/a.ts' }]")}];\n`,
        'sharkcraft/sharkcraft.config.ts': config(['knowledge.ts']),
      });
      const rows: string[] = [];
      for (const root of [mdRoot, tsRoot]) {
        const s = shrk(root, ['knowledge', 'stale-check']);
        expect(s.status).toBe(2);
        const row = invalidRow(s.stdout, 'doc.guide');
        expect(row).toContain('doc.guide → bogus:src/a.ts — malformed reference: unsupported kind "bogus"');
        rows.push(row!);
        const d = shrk(root, ['doctor']);
        expect(d.status).toBe(1);
        expect(d.stdout).toContain('invalid-reference');
      }
      expect(rows[0]).toBe(rows[1]);
    },
    T,
  );
});

describe('r78 a non-list references value never crashes — TS and Markdown, local and from a pack', () => {
  function fixture(): string {
    return tree('shrk-r78-nonlist-', {
      ...BASE,
      'sharkcraft/knowledge.ts': `export default [\n  ${entry('k.str', "'src/a.ts'")},\n  ${entry('k.obj', "{ kind: 'file', path: 'src/a.ts' }")},\n  ${entry('k.ok', "[{ kind: 'file', path: 'src/a.ts' }]")},\n];\n`,
      'sharkcraft/guide.md': '---\nid: doc.guide\nreferences: src/a.ts\n---\n# Guide\n',
      'sharkcraft/sharkcraft.config.ts': config(['knowledge.ts', 'guide.md']),
      'node_modules/@r78/badpack/package.json': JSON.stringify({ name: '@r78/badpack', version: '0.0.1', sharkcraft: { manifest: './manifest.json' } }),
      'node_modules/@r78/badpack/manifest.json': JSON.stringify({
        schema: 'sharkcraft.pack/v1',
        info: { name: '@r78/badpack', version: '0.0.1' },
        contributions: { knowledgeFiles: ['./knowledge.ts'] },
      }),
      'node_modules/@r78/badpack/knowledge.ts': `export default [${entry('p.str', "'src/a.ts'")}];\n`,
    });
  }
  const root = fixture();

  function noCrash(argv: readonly string[]): { status: number; stdout: string; stderr: string } {
    const r = shrk(root, argv);
    const all = `${r.stdout}\n${r.stderr}`;
    expect(all).not.toContain('Fatal');
    expect(all).not.toContain('is not a function');
    expect(all).not.toContain('is not iterable');
    expect([0, 1, 2]).toContain(r.status);
    return r;
  }

  test(
    'stale-check prints one INVALID row per non-list value; knowledge list / references keep working',
    () => {
      const s = noCrash(['knowledge', 'stale-check']);
      expect(s.status).toBe(2);
      for (const id of ['k.str', 'k.obj', 'doc.guide', 'p.str']) {
        expect(invalidRow(s.stdout, id)).toContain('`references` must be a list');
      }
      expect(noCrash(['knowledge', 'list']).status).toBe(0);
      expect(noCrash(['knowledge', 'references', 'k.obj']).status).toBe(0);
    },
    T,
  );

  test(
    'doctor reports it (invalid-reference, the entry kept); self-config doctor and packs doctor do not crash',
    () => {
      const d = noCrash(['doctor']);
      expect(d.status).toBe(1);
      expect(d.stdout).toContain('invalid-reference');
      noCrash(['self-config', 'doctor']);
      noCrash(['packs', 'doctor']);
    },
    T,
  );

  test(
    'quality, why and context do not crash',
    () => {
      noCrash(['quality', '--json']);
      noCrash(['why', 'src/a.ts']);
      noCrash(['context', '--task', 'change A']);
    },
    T,
  );
});

describe('r78 packs test --load reports what the consumer would hit', () => {
  test(
    'a non-list references value → asset-entry-invalid; an unreadable .md frontmatter → asset-entry-rejected; exit 1',
    () => {
      const packRoot = tree(
        'shrk-r78-packtest-',
        {
          'package.json': JSON.stringify({ name: '@r78/p', version: '0.0.1', sharkcraft: { manifest: './manifest.json' } }),
          'manifest.json': JSON.stringify({
            schema: 'sharkcraft.pack/v1',
            info: { name: '@r78/p', version: '0.0.1' },
            contributions: { knowledgeFiles: ['./knowledge.ts', './guide.md'] },
          }),
          'knowledge.ts': `export default [${entry('p.str', "'src/a.ts'")}];\n`,
          'guide.md': '---\nid: p.guide\nreferences:\n  - "file:src/a.ts"\n  - kind: file\n    path: src/b.ts\n---\n# Guide\n',
        },
        false,
      );
      const r = shrk(packRoot, ['packs', 'test', '.', '--load', '--json']);
      expect(r.status).toBe(1);
      const out = JSON.parse(r.stdout) as { issues: { code: string; message: string; severity: string }[] };
      const invalid = out.issues.find((i) => i.code === 'asset-entry-invalid');
      expect(invalid?.severity).toBe('error');
      expect(invalid?.message).toContain('knowledge.ts');
      expect(invalid?.message).toContain('`references` must be a list');
      const rejected = out.issues.find((i) => i.code === 'asset-entry-rejected' && i.message.startsWith('guide.md '));
      expect(rejected?.message).toContain('mixed string and map items in one list');
    },
    T,
  );
});

describe('r78 truly unparseable Markdown frontmatter takes the rejected channel', () => {
  test(
    'a pack .md whose frontmatter cannot be read is a rejected entry on the consumer surfaces — never a silently flattened doc',
    () => {
      const root = tree('shrk-r78-mdrej-', {
        ...BASE,
        'sharkcraft/knowledge.ts': `export default [${entry('k.ok', "[{ kind: 'file', path: 'src/a.ts' }]")}];\n`,
        'sharkcraft/sharkcraft.config.ts': config(['knowledge.ts']),
        'node_modules/@r78/mdrej/package.json': JSON.stringify({ name: '@r78/mdrej', version: '0.0.1', sharkcraft: { manifest: './manifest.json' } }),
        'node_modules/@r78/mdrej/manifest.json': JSON.stringify({
          schema: 'sharkcraft.pack/v1',
          info: { name: '@r78/mdrej', version: '0.0.1' },
          contributions: { knowledgeFiles: ['./guide.md'] },
        }),
        'node_modules/@r78/mdrej/guide.md': '---\nid: pack.guide\nthis line names no key\n---\n# Guide\n',
      });
      const c = shrk(root, ['packs', 'contributions']);
      expect(c.status).toBe(1);
      expect(c.stdout).toContain('guide.md');
      expect(c.stdout).toContain('pack.guide');
      const d = shrk(root, ['self-config', 'doctor']);
      expect(d.stdout).toContain('knowledge-invalid');
      expect(d.stdout).toContain('Expected "<key>:" at line 3');
      const list = shrk(root, ['knowledge', 'list', '--json']);
      expect(list.stdout).not.toContain('pack.guide');
    },
    T,
  );
});

describe('r78 write paths and the init seed', () => {
  test(
    'fix --knowledge-stale --apply refuses a Markdown entry loudly, naming the .md file — the file is untouched',
    () => {
      const guide = '---\nid: doc.guide\nreferences: [file:src/gone.ts]\n---\n# Guide\n';
      const root = tree('shrk-r78-fix-', {
        ...BASE,
        'sharkcraft/guide.md': guide,
        'sharkcraft/sharkcraft.config.ts': config(['guide.md']),
      });
      const r = shrk(root, ['fix', '--knowledge-stale', '--apply', '--drop-stale']);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('doc.guide');
      expect(r.stdout).toContain('sharkcraft/guide.md');
      expect(r.stdout).toContain('not auto-fixable');
      expect(readFileSync(join(root, 'sharkcraft/guide.md'), 'utf8')).toBe(guide);
    },
    T,
  );

  test(
    'the `shrk init` seed passes its own stale-check and quality',
    () => {
      const root = tree('shrk-r78-init-', { 'package.json': JSON.stringify({ name: 'r78-init', version: '0.0.0' }) });
      expect(shrk(root, ['init', '--no-gitignore', '--write']).status).toBe(0);
      const s = shrk(root, ['knowledge', 'stale-check']);
      expect(s.status).toBe(0);
      expect(s.stdout).toMatch(/(\d+) of \1 knowledge entries verified/);
      const q = shrk(root, ['quality', '--json']);
      expect(q.status).toBe(0);
      expect((JSON.parse(q.stdout) as { verdict: string }).verdict).toBe('pass');
    },
    T,
  );
});
