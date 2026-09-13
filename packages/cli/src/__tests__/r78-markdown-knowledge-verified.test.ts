/**
 * r78 — Markdown knowledge is verifiable (round 15, 15.2; option 2 — option 1
 * is rejected).
 *
 * A Markdown knowledge entry had no way to declare references, so it was always
 * unverifiable: `knowledge stale-check` 2 and therefore `quality` not-verified,
 * for local docs and for any pack shipping Markdown knowledge — with nothing a
 * pack author could do but delete the docs. A `references:` frontmatter list
 * now feeds the SAME references a TypeScript entry declares.
 *
 * Round 11 is kept: an entry nobody checked is never an implicit pass (no
 * "exclude Markdown from the exit decision"). An unreferenced .md is still
 * exit 2; what changed is that the remedy names the frontmatter key and the
 * valve each surface can use.
 *
 * Real workspaces and packs, the CLI from source.
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

/** A real, git-initialised workspace: `src/a.ts` plus `files`. */
function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r78-mdk-'));
  roots.push(root);
  const all: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'r78-mdk', version: '0.0.0', private: true }),
    'src/a.ts': 'export class Foo {}\nexport const A = 1;\n',
    ...files,
  };
  for (const [rel, body] of Object.entries(all)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  spawnSync('git', ['init', '-q'], { cwd: root });
  return root;
}

/** Two TypeScript entries, each verified against `src/a.ts`. */
const TS_ENTRIES =
  'export default [\n' +
  "  { id: 'k.one', title: 'One', type: 'technical', priority: 'medium', scope: [], tags: [], appliesWhen: [], content: 'About A.', references: [{ kind: 'file', path: 'src/a.ts' }] },\n" +
  "  { id: 'k.two', title: 'Two', type: 'technical', priority: 'medium', scope: [], tags: [], appliesWhen: [], content: 'About Foo.', references: [{ kind: 'symbol', symbol: 'Foo', path: 'src/a.ts' }] },\n" +
  '];\n';

function config(knowledgeFiles: readonly string[], extra = ''): string {
  return `export default { projectName: 'r78-mdk', knowledgeFiles: ${JSON.stringify(knowledgeFiles)}${extra ? `, ${extra}` : ''} };\n`;
}

function md(frontmatter: string, title = 'Guide'): string {
  return `---\n${frontmatter}\n---\n# ${title}\n\nHow A works.\n`;
}

/** A pack under the consumer's node_modules, contributing `contributions` with `files`. */
function packFiles(name: string, contributions: Record<string, readonly string[]>, files: Record<string, string>): Record<string, string> {
  const base = `node_modules/${name}`;
  const out: Record<string, string> = {
    [`${base}/package.json`]: JSON.stringify({ name, version: '0.0.1', sharkcraft: { manifest: './manifest.json' } }),
    [`${base}/manifest.json`]: JSON.stringify({ schema: 'sharkcraft.pack/v1', info: { name, version: '0.0.1' }, contributions }),
  };
  for (const [rel, body] of Object.entries(files)) out[`${base}/${rel}`] = body;
  return out;
}

interface IQualityJson {
  readonly verdict: string;
  readonly accepted: readonly string[];
  readonly items: readonly { readonly id: string; readonly status: string; readonly notes: readonly string[] }[];
}

function knowledgeItem(q: IQualityJson): IQualityJson['items'][number] {
  return q.items.find((i) => i.id === 'knowledge-stale')!;
}

describe('r78 a Markdown entry with a references: list verifies like a TypeScript one', () => {
  test(
    'local .md + verified TS entries → stale-check 0 (3 of 3) and quality pass',
    () => {
      const root = workspace({
        'sharkcraft/knowledge.ts': TS_ENTRIES,
        'sharkcraft/guide.md': md('id: doc.guide\nreferences: [file:src/a.ts]'),
        'sharkcraft/sharkcraft.config.ts': config(['knowledge.ts', 'guide.md']),
      });
      const s = shrk(root, ['knowledge', 'stale-check']);
      expect(s.status).toBe(0);
      expect(s.stdout).toContain('3 of 3 knowledge entries verified');
      const q = shrk(root, ['quality', '--json']);
      expect(q.status).toBe(0);
      const run = JSON.parse(q.stdout) as IQualityJson;
      expect(run.verdict).toBe('pass');
      expect(knowledgeItem(run).status).toBe('passed');
    },
    T,
  );

  test(
    'the same through a pack under node_modules — knowledgeFiles, docsFiles and ruleFiles .md (paths resolve against the consumer root)',
    () => {
      const root = workspace({
        'sharkcraft/knowledge.ts': TS_ENTRIES,
        'sharkcraft/sharkcraft.config.ts': config(['knowledge.ts']),
        ...packFiles(
          '@r78/mdpack',
          { knowledgeFiles: ['./guide.md'], docsFiles: ['./docs.md'], ruleFiles: ['./rule.md'] },
          {
            'guide.md': md('id: pack.guide\nreferences: [file:src/a.ts]'),
            'docs.md': md('id: pack.docs\nreferences:\n  - file:src/a.ts'),
            'rule.md': md('id: pack.rule\ntype: rule\nreferences:\n  - kind: symbol\n    symbol: Foo\n    path: src/a.ts'),
          },
        ),
      });
      const s = shrk(root, ['knowledge', 'stale-check']);
      expect(s.status).toBe(0);
      expect(s.stdout).toContain('5 of 5 knowledge entries verified');
      const q = shrk(root, ['quality', '--json']);
      expect(q.status).toBe(0);
      expect((JSON.parse(q.stdout) as IQualityJson).verdict).toBe('pass');
    },
    T,
  );

  test(
    'a stale .md reference is CHECKED, not just parsed — exit 1, the row names the .md file',
    () => {
      const root = workspace({
        'sharkcraft/knowledge.ts': TS_ENTRIES,
        'sharkcraft/guide.md': md('id: doc.guide\nreferences: [file:src/gone.ts]'),
        'sharkcraft/sharkcraft.config.ts': config(['knowledge.ts', 'guide.md']),
      });
      const s = shrk(root, ['knowledge', 'stale-check']);
      expect(s.status).toBe(1);
      const row = s.stdout.split('\n').find((l) => l.includes('doc.guide → file:src/gone.ts'));
      expect(row).toContain('STALE');
      expect(row).toContain('(sharkcraft/guide.md)');
      const json = JSON.parse(shrk(root, ['knowledge', 'stale-check', '--json']).stdout) as {
        gate: { rules: { violations: { id: string; file?: string }[] }[] };
      };
      const v = json.gate.rules.flatMap((r) => r.violations).find((x) => x.id === 'doc.guide');
      expect(v?.file).toBe('sharkcraft/guide.md');
    },
    T,
  );
});

describe('r78 an unreferenced .md is still NOT VERIFIED — the remedy names the key and the valve', () => {
  test(
    'stale-check 2 with the frontmatter key, --min-referenced and sourceFormat; quality not-verified naming knowledgeCheck.minReferenced',
    () => {
      const root = workspace({
        'sharkcraft/knowledge.ts': TS_ENTRIES,
        'sharkcraft/guide.md': md('id: doc.guide'),
        'sharkcraft/sharkcraft.config.ts': config(['knowledge.ts', 'guide.md']),
      });
      const s = shrk(root, ['knowledge', 'stale-check']);
      expect(s.status).toBe(2);
      expect(s.stdout).toContain(
        'sharkcraft/guide.md (1): doc.guide — Markdown: add a references: frontmatter list (e.g. references: [file:src/a.ts])',
      );
      expect(s.stdout).toContain('Declare references[] (TypeScript) or a references: frontmatter list (Markdown)');
      expect(s.stdout).toContain('--min-referenced <ratio>');
      const json = JSON.parse(shrk(root, ['knowledge', 'stale-check', '--json']).stdout) as {
        entryVerdicts: { entryId: string; sourceFormat: string; verdict: string }[];
      };
      const format = Object.fromEntries(json.entryVerdicts.map((v) => [v.entryId, v.sourceFormat]));
      expect(format).toEqual({ 'k.one': 'typescript', 'k.two': 'typescript', 'doc.guide': 'markdown' });

      const q = shrk(root, ['quality', '--json']);
      expect(q.status).toBe(2);
      const run = JSON.parse(q.stdout) as IQualityJson;
      expect(run.verdict).toBe('not-verified');
      const notes = knowledgeItem(run).notes.join('\n');
      expect(notes).toContain('references: frontmatter list (Markdown)');
      expect(notes).toContain('knowledgeCheck.minReferenced');
      expect(notes).toContain('sharkcraft/guide.md: Markdown: add a references: frontmatter list');
      expect(run.accepted).toEqual([]);
    },
    T,
  );

  test(
    'a pack-owned unreferenced .md names the pack (stale-check text and --json entryVerdicts[].pack)',
    () => {
      const root = workspace({
        'sharkcraft/knowledge.ts': TS_ENTRIES,
        'sharkcraft/sharkcraft.config.ts': config(['knowledge.ts']),
        ...packFiles('@r78/mdpack', { docsFiles: ['./guide.md'] }, { 'guide.md': md('id: pack.guide') }),
      });
      const s = shrk(root, ['knowledge', 'stale-check']);
      expect(s.status).toBe(2);
      expect(s.stdout).toContain('pack @r78/mdpack (Markdown): add a references: frontmatter list upstream');
      expect(s.stdout).toContain('Entries a pack contributes (pack @r78/mdpack) are fixed in the pack.');
      const json = JSON.parse(shrk(root, ['knowledge', 'stale-check', '--json']).stdout) as {
        entryVerdicts: { entryId: string; pack?: string; sourceFormat: string }[];
      };
      const v = json.entryVerdicts.find((x) => x.entryId === 'pack.guide');
      expect(v).toMatchObject({ pack: '@r78/mdpack', sourceFormat: 'markdown' });
    },
    T,
  );

  test(
    'knowledgeCheck.minReferenced accepts the remainder — printed by the verb, and in quality --json top-level accepted',
    () => {
      const root = workspace({
        'sharkcraft/knowledge.ts': TS_ENTRIES,
        'sharkcraft/guide.md': md('id: doc.guide'),
        'sharkcraft/sharkcraft.config.ts': config(['knowledge.ts', 'guide.md'], 'knowledgeCheck: { minReferenced: 0.5 }'),
      });
      const s = shrk(root, ['knowledge', 'stale-check']);
      expect(s.status).toBe(0);
      expect(s.stdout).toContain('accepted by knowledgeCheck.minReferenced: 0.5');
      const q = shrk(root, ['quality', '--json']);
      expect(q.status).toBe(0);
      const run = JSON.parse(q.stdout) as IQualityJson;
      expect(run.verdict).toBe('pass');
      expect(run.accepted.some((a) => a.startsWith('knowledge-stale: accepted by knowledgeCheck.minReferenced: 0.5'))).toBe(true);
      // The text prints the acceptance under the knowledge item it waived.
      const text = shrk(root, ['quality']);
      expect(text.status).toBe(0);
      expect(text.stdout).toContain('accepted by knowledgeCheck.minReferenced: 0.5: examined 2 of 3 knowledge entries');
    },
    T,
  );
});
