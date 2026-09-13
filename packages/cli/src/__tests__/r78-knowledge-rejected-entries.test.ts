/**
 * r78 — a knowledge entry the LOADER refused is never a clean pass, on every
 * verdict surface (round 15 follow-up, F3 + F12), the CLI from source.
 *
 * Before: a TypeScript entry missing its `content`, or a Markdown file whose
 * frontmatter cannot be read as declared, was refused through the round-12
 * rejection channel — and `knowledge stale-check` printed "2 of 2 knowledge
 * entries verified ✓" at exit 0, `quality` passed and `shrk doctor` said
 * "Ready for AI-agent use ✓" over it (only `self-config doctor` and `knowledge
 * list` named it). Now each refused entry is an INVALID-class row (`rejected at
 * load — not checked: <reasons>`), counted UNEXAMINED: exit 2 by default, 1
 * under `--fail-on invalid`, and no valve accepts it.
 *
 * Real workspaces and THE census (fixtures/r76-census, with its Markdown
 * knowledge file) copied under node_modules.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts');
const FIXTURE = join(REPO_ROOT, 'packages/inspector/src/__tests__/fixtures/r76-census');
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

function tree(prefix: string, files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

/** One verified TypeScript entry, one refused TypeScript entry (no `content`), one refused Markdown file (`title` a list). */
function localFixture(): string {
  return tree('shrk-r78-refused-cli-', {
    'package.json': JSON.stringify({ name: 'r78-refused', version: '0.0.0', private: true }),
    'src/a.ts': 'export const a = 1;\n',
    'sharkcraft/sharkcraft.config.ts':
      "export default { projectName: 'r78-refused', knowledgeFiles: ['knowledge.ts', 'broken.md'] };\n",
    'sharkcraft/knowledge.ts':
      'export default [\n' +
      "  { id: 'k.ok', title: 'Ok', type: 'technical', priority: 'low', scope: [], tags: [], appliesWhen: [], content: 'About a.', references: [{ kind: 'file', path: 'src/a.ts' }] },\n" +
      "  { id: 'k.bad', title: 'Bad', type: 'technical', priority: 'low', scope: [], tags: [], appliesWhen: [] },\n" +
      '];\n',
    // A BLOCK list: an inline `title: [A, B]` is the title text since round 15 closing.
    'sharkcraft/broken.md': '---\nid: doc.broken\ntitle:\n  - A\n  - B\n---\n# Broken\n',
  });
}

/** The row the stale-check prints for a refused entry. */
function invalidRow(stdout: string, id: string): string {
  return stdout.split('\n').find((l) => l.trimStart().startsWith('INVALID') && l.includes(`${id} — rejected at load — not checked:`)) ?? '';
}

describe('r78 F3 — a local refused entry on stale-check, quality and doctor', () => {
  const root = localFixture();

  test(
    'stale-check: one INVALID row each, naming the file; 2 by default, 1 under --fail-on invalid, and --min-referenced never accepts it',
    () => {
      const s = shrk(root, ['knowledge', 'stale-check']);
      expect(s.status).toBe(2);
      expect(s.stdout).toContain('entries in scope: 1 · verified: 1 · stale: 0 · unverifiable: 0 (0%) · rejected at load: 2');
      expect(invalidRow(s.stdout, 'k.bad')).toContain('content: must be a string  (sharkcraft/knowledge.ts)');
      expect(invalidRow(s.stdout, 'doc.broken')).toContain('title: must be a single value (got a list)  (sharkcraft/broken.md)');
      expect(s.stdout).toContain('2 knowledge entries were rejected at load and never checked (listed above as INVALID)');
      expect(s.stdout).not.toContain('no stale or missing references. ✓');

      const failOn = shrk(root, ['knowledge', 'stale-check', '--fail-on', 'invalid']);
      expect(failOn.status).toBe(1);
      expect(failOn.stdout).toContain('2 knowledge entries rejected at load (--fail-on=invalid)');

      expect(shrk(root, ['knowledge', 'stale-check', '--min-referenced', '0']).status).toBe(2);
    },
    T,
  );

  test(
    '--json: rejectedEntries[] and the knowledge-rejected-entries rule (skipped, examined 0) in the gate envelope',
    () => {
      const r = shrk(root, ['knowledge', 'stale-check', '--json']);
      expect(r.status).toBe(2);
      const out = JSON.parse(r.stdout) as {
        rejectedEntries: { entryId?: string; source: string; message: string }[];
        gate: { exit: number; rules: { id: string; status: string; coverage: { expected: number; examined: number } }[] };
      };
      expect(out.rejectedEntries.map((e) => [e.entryId, e.source])).toEqual([
        ['doc.broken', 'sharkcraft/broken.md'],
        ['k.bad', 'sharkcraft/knowledge.ts'],
      ]);
      expect(out.gate.exit).toBe(2);
      const rule = out.gate.rules.find((x) => x.id === 'knowledge-rejected-entries');
      expect(rule).toMatchObject({ status: 'skipped', coverage: { expected: 2, examined: 0 } });
    },
    T,
  );

  test(
    "quality's knowledge item is not a pass and names each refused entry; doctor settles NOT VERIFIED and names each",
    () => {
      const q = shrk(root, ['quality', '--json']);
      expect(q.status).toBe(2);
      const report = JSON.parse(q.stdout) as {
        verdict: string;
        items: { id: string; status: string; notes: string[]; data?: { rejectedEntries?: { entryId?: string }[] } }[];
      };
      expect(report.verdict).toBe('not-verified');
      const item = report.items.find((i) => i.id === 'knowledge-stale')!;
      expect(item.status).not.toBe('passed');
      expect(item.notes.some((n) => n.startsWith('k.bad (sharkcraft/knowledge.ts) — rejected at load — not checked:'))).toBe(true);
      expect(item.notes.some((n) => n.startsWith('doc.broken (sharkcraft/broken.md) — rejected at load — not checked:'))).toBe(true);
      expect((item.data?.rejectedEntries ?? []).map((e) => e.entryId).sort()).toEqual(['doc.broken', 'k.bad']);

      const d = shrk(root, ['doctor']);
      expect(d.status).toBe(2);
      expect(d.stdout).toContain('k.bad in sharkcraft/knowledge.ts (default[1]): rejected at load — not checked: content: must be a string');
      expect(d.stdout).toContain('doc.broken in sharkcraft/broken.md: rejected at load — not checked:');
      expect(d.stdout).toContain('Verdict: NOT VERIFIED');
      expect(d.stdout).not.toContain('Ready for AI-agent use. ✓');
    },
    T,
  );
});

describe('r78 F10 review — a non-boolean `required` is never rendered as required', () => {
  const root = tree('shrk-r78-required-render-', {
    'package.json': JSON.stringify({ name: 'r78-required-render', version: '0.0.0', private: true }),
    'src/a.ts': 'export const a = 1;\n',
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'r78-req', knowledgeFiles: ['knowledge.ts'] };\n",
    'sharkcraft/knowledge.ts':
      "export default [{ id: 'k.req', title: 'Req', type: 'technical', priority: 'low', scope: [], tags: [], appliesWhen: [], content: 'x', references: [{ kind: 'file', path: 'src/a.ts', required: 'yes' }] }];\n",
  });

  test(
    'text, markdown and html agree: the INVALID row carries no required marker',
    () => {
      const text = shrk(root, ['knowledge', 'stale-check']);
      const textRow = text.stdout.split('\n').find((l) => l.includes('k.req →')) ?? '';
      expect(textRow).toContain('INVALID');
      expect(textRow).not.toContain('[REQ]');
      const md = shrk(root, ['knowledge', 'stale-check', '--format', 'markdown']);
      const mdRow = md.stdout.split('\n').find((l) => l.includes('`k.req`')) ?? '';
      expect(mdRow).toContain('**INVALID**');
      expect(mdRow).not.toContain('(required)');
      const html = shrk(root, ['knowledge', 'stale-check', '--format', 'html']);
      expect(html.stdout).toContain('<tr><td>INVALID</td><td></td><td>k.req</td>');
    },
    T,
  );
});

describe('r78 F3 + F12 — THE census: every refused knowledge-family entry, its Markdown one included', () => {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r78-refused-census-cli-'));
  roots.push(root);
  cpSync(join(FIXTURE, 'consumer'), root, { recursive: true });
  cpSync(join(FIXTURE, 'pack'), join(root, 'node_modules/@r76/census'), { recursive: true });
  const census = JSON.parse(readFileSync(join(FIXTURE, 'census.json'), 'utf8')) as {
    slots: Record<string, { file: string; kind: string; entryId: string | null; field: string }>;
    markdown?: { files: { file: string; kind: string; entryId: string | null; field: string }[] };
  };
  const KNOWLEDGE_KINDS = new Set(['knowledge', 'rule', 'path', 'path-convention', 'docs']);
  const files = [...Object.values(census.slots), ...(census.markdown?.files ?? [])].filter((c) => KNOWLEDGE_KINDS.has(c.kind));

  test(
    'stale-check prints an INVALID row for each (pack-attributed), doctor --json names each, quality carries them',
    () => {
      expect(files.map((c) => c.entryId)).toContain('cz.kmd-bad');
      const s = shrk(root, ['knowledge', 'stale-check']);
      expect(s.status).toBe(2);
      for (const c of files) {
        const row = invalidRow(s.stdout, c.entryId!);
        expect({ id: c.entryId, row: row.includes(`: ${c.field}:`) && row.includes(`(node_modules/@r76/census/${c.file}, pack @r76/census)`) }).toEqual({
          id: c.entryId,
          row: true,
        });
      }
      const d = shrk(root, ['doctor', '--json']);
      const doctor = JSON.parse(d.stdout) as { exitCode: number; checks: { code?: string; message: string }[]; shortfalls?: string[] };
      expect(d.status).toBe(doctor.exitCode);
      expect(doctor.exitCode).not.toBe(0);
      for (const c of files) {
        expect({
          id: c.entryId,
          named: doctor.checks.some((x) => x.code === 'knowledge-entry-rejected' && x.message.startsWith(`${c.entryId} in node_modules/@r76/census/${c.file}`)),
        }).toEqual({ id: c.entryId, named: true });
      }
      expect((doctor.shortfalls ?? []).some((x) => x.includes('rejected at load'))).toBe(true);
      const q = JSON.parse(shrk(root, ['quality', '--json']).stdout) as {
        items: { id: string; status: string; data?: { rejectedEntries?: { entryId?: string }[] } }[];
      };
      const item = q.items.find((i) => i.id === 'knowledge-stale')!;
      expect(item.status).not.toBe('passed');
      expect((item.data?.rejectedEntries ?? []).map((e) => e.entryId ?? null).sort()).toEqual(files.map((c) => c.entryId).sort());
    },
    180_000,
  );
});
