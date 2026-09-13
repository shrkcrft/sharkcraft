/**
 * r78 — round 15 closing, lane A: frontmatter parity and knowledge remedy
 * hints, end to end (real workspaces, a real pack, the CLI from source).
 *
 *   A1 a decision's `title: [WIP]` is the title `[WIP]`, as the old splitter
 *      read it — the F6 migration REJECTED the record as "a list";
 *   A2 a BOM-prefixed Markdown knowledge file's frontmatter is read (it loaded
 *      as `doc.<file>`, unverifiable); an unterminated block is REFUSED with its
 *      reason (it loaded silently as a body-only entry);
 *   A3 a missing path's hint branches on who fixes it — a Markdown entry's
 *      `references:` frontmatter, the pack (`root: pack` when the pack ships
 *      the path), a rename for a TypeScript entry — from ONE authority, so the
 *      fix preview's draft says the same thing;
 *   A4 an unverifiable entry whose references exist but none is checkable is
 *      told to fix them — never "declare references[]" / "add a references:
 *      frontmatter list" it already has — on the heading, the file lines, the
 *      lead, `--require-references` and `quality`;
 *   A5 a Markdown decision's (and Markdown knowledge file's) rejection is
 *      labelled `(Markdown file)`, not `(default)` as if it were a module's
 *      default export.
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

function shrk(cwd: string, argv: readonly string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync('bun', ['run', CLI_MAIN, '--no-hints', ...argv], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r78-closing-'));
  roots.push(root);
  for (const [rel, body] of Object.entries({
    'package.json': JSON.stringify({ name: 'r78-closing', version: '0.0.0', private: true }),
    'src/a.ts': 'export class Foo {}\nexport const A = 1;\n',
    ...files,
  })) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

const entry = (id: string, refs: string): string =>
  `  { id: '${id}', title: '${id}', type: 'technical', priority: 'medium', scope: [], tags: [], appliesWhen: [], content: 'C.'${refs} },\n`;

const PACK = '@r78/closing-pack';
const PACK_DIR = `node_modules/${PACK}`;

/** Every item's case in one workspace (the fail-before fixture of this lane). */
function fullWorkspace(): string {
  return workspace({
    'sharkcraft/sharkcraft.config.ts':
      "export default { projectName: 'r78-closing', knowledgeFiles: ['knowledge.ts', 'guide.md', 'bad-refs.md', 'bom.md', 'unterminated.md'] };\n",
    'sharkcraft/knowledge.ts':
      'export default [\n' +
      entry('k.ok', ", references: [{ kind: 'file', path: 'src/a.ts' }]") +
      entry('k.none', '') +
      entry('k.bad', ", references: [{ kind: 'file' }]") +
      entry('k.gone', ", references: [{ kind: 'file', path: 'src/gone.ts' }]") +
      '];\n',
    'sharkcraft/guide.md': '---\nid: doc.guide\nreferences: [file:src/gone.ts]\n---\n# Guide\n\nBody.\n',
    'sharkcraft/bad-refs.md': '---\nid: doc.bad-refs\nreferences:\n  - kind: file\n---\n# Bad refs\n\nBody.\n',
    'sharkcraft/bom.md': '\uFEFF---\nid: doc.bom-entry\nreferences: [file:src/a.ts]\n---\n# BOM\n\nBody.\n',
    'sharkcraft/unterminated.md': '---\nid: doc.unterm\ntitle: Unterminated\n\n# Body\n\nText.\n',
    'sharkcraft/decisions/wip.md': '---\nid: wip-title\ntitle: [WIP]\nstatus: accepted\n---\n\n## Context\nC.\n',
    'sharkcraft/decisions/broken.md': '---\nid: broken\njust some text\n---\n',
    [`${PACK_DIR}/package.json`]: JSON.stringify({ name: PACK, version: '0.0.1', sharkcraft: { manifest: './manifest.json' } }),
    [`${PACK_DIR}/manifest.json`]: JSON.stringify({
      schema: 'sharkcraft.pack/v1',
      info: { name: PACK, version: '0.0.1' },
      contributions: { knowledgeFiles: ['./knowledge.md'] },
    }),
    [`${PACK_DIR}/docs/shipped.md`]: '# shipped\n',
    [`${PACK_DIR}/knowledge.md`]: '---\nid: pack.guide\nreferences: [file:docs/shipped.md]\n---\n# Pack guide\n\nBody.\n',
  });
}

interface IStaleJson {
  readonly entryVerdicts: readonly { readonly entryId: string; readonly verdict: string }[];
  readonly rejectedEntries: readonly { readonly label: string; readonly source: string; readonly reasons: readonly string[] }[];
  readonly referenceChecks: readonly { readonly entryId: string; readonly outcome: string; readonly suggestion?: string }[];
  readonly gate: { readonly rules: readonly { readonly id: string; readonly violations: readonly { readonly id: string; readonly message: string }[] }[] };
}

/** Every object under `v` carrying `key` (the fix preview nests its suggestions). */
function objectsWith(v: unknown, key: string, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(v)) for (const x of v) objectsWith(x, key, out);
  else if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (key in o) out.push(o);
    for (const x of Object.values(o)) objectsWith(x, key, out);
  }
  return out;
}

describe('r78 round 15 closing (lane A) — frontmatter parity and remedy hints, end to end', () => {
  const root = fullWorkspace();
  let stale: IStaleJson | undefined;
  const staleJson = (): IStaleJson => {
    if (stale) return stale;
    const s = shrk(root, ['knowledge', 'stale-check', '--json']);
    expect(s.status).toBe(1); // k.gone / doc.guide / pack.guide are stale
    stale = JSON.parse(s.stdout) as IStaleJson;
    return stale;
  };
  const hint = (id: string): string =>
    staleJson().referenceChecks.find((c) => c.entryId === id && c.outcome !== 'ok')?.suggestion ?? '';

  test(
    'A2: a BOM file reads its frontmatter; an unterminated block is REFUSED with its reason',
    () => {
      const j = staleJson();
      const verdict = new Map(j.entryVerdicts.map((v) => [v.entryId, v.verdict]));
      expect(verdict.get('doc.bom-entry')).toBe('verified');
      expect(verdict.has('doc.bom')).toBe(false);
      expect(verdict.has('doc.unterminated')).toBe(false);
      expect(j.rejectedEntries.map((r) => ({ label: r.label, source: r.source, reasons: r.reasons }))).toEqual([
        { label: 'doc.unterminated', source: 'sharkcraft/unterminated.md', reasons: ['frontmatter: an opening --- line has no closing --- line'] },
      ]);
    },
    T,
  );

  test(
    "A3: a missing path's hint names who fixes it — Markdown frontmatter, the pack, or a rename",
    () => {
      expect(hint('doc.guide')).toContain("edit this reference's path in the references: frontmatter of sharkcraft/guide.md");
      expect(hint('doc.guide')).not.toContain('preview the rename');
      expect(hint('pack.guide')).toContain(`shipped inside pack ${PACK}`);
      expect(hint('pack.guide')).toContain('declare root: pack');
      expect(hint('k.gone')).toContain('shrk knowledge rename-file');
    },
    T,
  );

  test(
    "A3: one authority — the fix preview's draft is the stale-check's hint, row for row",
    () => {
      const f = shrk(root, ['fix', 'preview', '--knowledge-stale', '--json']);
      const drafts = new Map(objectsWith(JSON.parse(f.stdout), 'draftBody').map((o) => [String(o['targetId']), String(o['draftBody'])]));
      for (const id of ['doc.guide', 'pack.guide', 'k.gone']) {
        expect({ id, draft: drafts.get(id) }).toEqual({ id, draft: `// suggestion: ${hint(id)}` });
      }
    },
    T,
  );

  test(
    'A4: --require-references tells a declared-but-malformed entry to fix it, a bare one to declare',
    () => {
      const s = shrk(root, ['knowledge', 'stale-check', '--require-references', '--json']);
      const rule = (JSON.parse(s.stdout) as IStaleJson).gate.rules.find((r) => r.id === 'knowledge-references')!;
      const msg = (id: string): string => rule.violations.find((v) => v.id === id && v.message.startsWith('UNVERIFIABLE'))?.message ?? '';
      expect(msg('k.bad')).toContain('declare nothing checkable — fix the item its INVALID / UNKNOWN row names');
      expect(msg('k.bad')).not.toContain('declare references[]');
      expect(msg('doc.bad-refs')).not.toContain('add a references: frontmatter list');
      expect(msg('k.none')).toContain('declare references[]');
    },
    T,
  );

  test(
    "A4: the text heading and a mixed file's lines branch on the reason",
    () => {
      const s = shrk(root, ['knowledge', 'stale-check']);
      expect(s.stdout).toContain('where none is declared; where some are, fix the item each INVALID / UNKNOWN row names');
      expect(s.stdout).toContain('sharkcraft/knowledge.ts (1): k.none\n');
      expect(s.stdout).toContain('sharkcraft/knowledge.ts (1): k.bad — its references[] / anchors[] declare nothing checkable');
    },
    T,
  );

  test(
    'A1 + A5: `title: [WIP]` is not refused; a Markdown decision rejection reads (Markdown file) on every surface',
    () => {
      const d = shrk(root, ['self-config', 'doctor']);
      expect(d.status).toBe(1); // broken.md — a stray line naming no key
      expect(d.stdout).toContain('decision (no id) in sharkcraft/decisions/broken.md (Markdown file) was rejected by its loader');
      expect(d.stdout).not.toContain('decisions/wip.md');
      expect(d.stdout).not.toMatch(/\.md \(default\)/);
      const c = shrk(root, ['packs', 'contributions']);
      expect(c.stdout).toContain('(no id) (Markdown file) — frontmatter: Expected "<key>:" at line 3');
      expect(c.stdout).toContain("'doc.unterminated' (Markdown file) — frontmatter: an opening --- line has no closing --- line");
      expect(c.stdout).not.toContain('(default)');
      expect(c.stdout).not.toContain('decisions/wip.md');
    },
    T,
  );

  test(
    "A5 (review): the inventory's markdown table labels a Markdown rejection (Markdown file) — never the slot `[-1]`",
    () => {
      const c = shrk(root, ['packs', 'contributions', '--format', 'markdown']);
      const at = c.stdout.indexOf('## Rejected entries');
      expect(at).toBeGreaterThanOrEqual(0);
      const table = c.stdout.slice(at);
      expect(table).toContain(
        '| `sharkcraft/decisions/broken.md` | decision |  | (no id) (Markdown file) | frontmatter: Expected "<key>:" at line 3 |',
      );
      expect(table).toContain('| `doc.unterminated` (Markdown file) | frontmatter: an opening --- line has no closing --- line |');
      expect(c.stdout).not.toContain('[-1]');
    },
    T,
  );

  test(
    "A4 (review): the markdown heading is the text heading — THE reason-aware authority, a mixed run's both clauses",
    () => {
      const text = shrk(root, ['knowledge', 'stale-check']).stdout;
      const md = shrk(root, ['knowledge', 'stale-check', '--format', 'markdown']).stdout;
      const textHeading = /UNVERIFIABLE \((\d+)\) — never checked; (.+):\n/.exec(text);
      const mdHeading = /## Unverifiable entries \((\d+)\) — (.+)\n/.exec(md);
      expect(textHeading?.[2]).toContain('where none is declared; where some are, fix the item each INVALID / UNKNOWN row names');
      expect({ n: mdHeading?.[1], clause: mdHeading?.[2] }).toEqual({ n: textHeading?.[1], clause: textHeading?.[2] });
    },
    T,
  );
});

describe('r78 round 15 closing (A4) — a run whose unverifiable entries all declare malformed references', () => {
  const root = workspace({
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'r78-closing', knowledgeFiles: ['knowledge.ts', 'bad-refs.md'] };\n",
    'sharkcraft/knowledge.ts':
      'export default [\n' + entry('k.ok', ", references: [{ kind: 'file', path: 'src/a.ts' }]") + entry('k.bad', ", references: [{ kind: 'file' }]") + '];\n',
    'sharkcraft/bad-refs.md': '---\nid: doc.bad-refs\nreferences:\n  - kind: file\n---\n# Bad refs\n\nBody.\n',
  });

  test(
    'stale-check (exit 2) and quality never tell them to declare or add a references list',
    () => {
      const s = shrk(root, ['knowledge', 'stale-check']);
      expect(s.status).toBe(2);
      expect(s.stdout).toContain('each declares references, none checkable — fix the item each INVALID / UNKNOWN row names');
      expect(s.stdout).toContain('Make a declared reference checkable — fix the item each INVALID / UNKNOWN row names');
      expect(s.stdout).not.toContain('add a references: frontmatter list');
      expect(s.stdout).not.toContain('Declare references[] (TypeScript)');
      const q = shrk(root, ['quality', '--json']);
      const notes = (JSON.parse(q.stdout) as { items: { id: string; notes: string[] }[] }).items.find((i) => i.id === 'knowledge-stale')!.notes;
      expect(notes).toContain(
        'remedy: Make a declared reference checkable — fix the item each INVALID / UNKNOWN row names (ids listed above), or accept a floor explicitly with knowledgeCheck.minReferenced in sharkcraft.config.ts (quality takes no --min-referenced flag).',
      );
      expect(notes.join('\n')).not.toContain('add a references: frontmatter list');
      expect(notes).toContain(
        'sharkcraft/knowledge.ts: its references[] / anchors[] declare nothing checkable — fix the item its INVALID / UNKNOWN row names, or add a checkable one',
      );
    },
    T,
  );

  test(
    '--format markdown reads THE heading too — it told entries with declared references to "declare references[] … or a references: frontmatter list"',
    () => {
      const md = shrk(root, ['knowledge', 'stale-check', '--format', 'markdown']);
      expect(md.status).toBe(2);
      expect(/## Unverifiable entries \(2\) — (.+)\n/.exec(md.stdout)?.[1]).toBe(
        'each declares references, none checkable — fix the item each INVALID / UNKNOWN row names',
      );
      expect(md.stdout).not.toContain('add a references: frontmatter list');
      expect(md.stdout).not.toContain('Declare references[] (TypeScript)');
      expect(md.stdout).not.toContain('declare references[] (TypeScript)');
    },
    T,
  );
});
