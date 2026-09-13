/**
 * r78 — round 15 review of 15.2, on the CLI and MCP surfaces.
 *
 *   - `shrk ide symbol` iterated `entry.references` / `entry.anchors` raw, so a
 *     non-list `references` (`{} is not iterable`) or a Markdown `null` item
 *     (`null is not an object (evaluating 'r.kind')`) crashed it — the one
 *     inspection-backed verb the lane's `knowledgeReferences` sweep missed.
 *   - A `null` reference item read `is the string "null"` in the stale-check
 *     and `is not an object (got null)` in the doctor; one wording now.
 *   - A non-list `anchors` value or a `null` anchor crashed `knowledge
 *     stale-check` (and so `quality`'s knowledge item) and `knowledge anchors`;
 *     each is an INVALID row / a listed malformed claim now.
 *   - `knowledge references --json` and MCP `get_knowledge_references` return
 *     ONE listing (the CLI dropped malformed items, MCP returned them raw).
 *
 * Real workspaces, the CLI from source, the real MCP tool over a real inspection.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import { ALL_TOOLS } from '@shrkcrft/mcp-server';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts');
const T = 60_000;
const roots: string[] = [];

/** What a crash printed — never our own "is not an object (got null)" wording. */
const CRASH = /Fatal|is not iterable|is not a function|\(evaluating '/;

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
  const out = { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
  expect(`${out.stdout}\n${out.stderr}`).not.toMatch(CRASH);
  return out;
}

function tree(prefix: string, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  const all: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'r78-claims', version: '0.0.0', private: true }),
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

function entry(id: string, claims: string): string {
  return `{ id: '${id}', title: '${id}', type: 'technical', priority: 'medium', scope: [], tags: [], appliesWhen: [], content: 'About ${id}.', ${claims} }`;
}

function config(knowledgeFiles: readonly string[]): string {
  return `export default { projectName: 'r78-claims', knowledgeFiles: ${JSON.stringify(knowledgeFiles)} };\n`;
}

/** A non-list `references` (TS), a well-formed symbol reference (TS), and a Markdown list holding a `null`. */
function referencesFixture(): string {
  return tree('shrk-r78-claims-refs-', {
    'sharkcraft/knowledge.ts':
      'export default [\n' +
      `  ${entry('k.obj', "references: { kind: 'symbol', symbol: 'Foo', path: 'src/a.ts' }")},\n` +
      `  ${entry('k.sym', "references: [{ kind: 'symbol', symbol: 'Foo', path: 'src/a.ts' }]")},\n` +
      '];\n',
    'sharkcraft/guide.md': '---\nid: doc.guide\nreferences: [symbol:Foo@src/a.ts, null]\n---\n# Guide\n',
    'sharkcraft/sharkcraft.config.ts': config(['knowledge.ts', 'guide.md']),
  });
}

describe('r78 ide symbol reads THE accessors — a malformed references value never crashes it', () => {
  test(
    'a non-list references object and a null Markdown item: exit 0, the well-formed references still match',
    () => {
      const root = referencesFixture();
      const r = shrk(root, ['ide', 'symbol', 'Foo', '--json']);
      expect(r.status).toBe(0);
      const report = JSON.parse(r.stdout) as { references: { sourceId: string; matchedField: string }[] };
      expect(report.references).toContainEqual(expect.objectContaining({ sourceId: 'k.sym', matchedField: 'references' }));
      expect(report.references).toContainEqual(expect.objectContaining({ sourceId: 'doc.guide', matchedField: 'references' }));
      expect(report.references.some((x) => x.sourceId === 'k.obj' && x.matchedField === 'references')).toBe(false);
    },
    T,
  );
});

describe('r78 a null reference item carries ONE wording — the stale-check says what the doctor says', () => {
  test(
    'INVALID row "is not an object (got null)", and the doctor names the same item',
    () => {
      const root = referencesFixture();
      const s = shrk(root, ['knowledge', 'stale-check']);
      expect(s.status).toBe(2);
      const row = s.stdout.split('\n').find((l) => l.includes('doc.guide → null'));
      expect(row).toContain('INVALID');
      expect(row).toContain('malformed reference: is not an object (got null).');
      expect(s.stdout).not.toContain('is the string "null"');
      const d = shrk(root, ['doctor']);
      expect(d.status).toBe(1);
      expect(d.stdout).toContain('Entry "doc.guide" reference #2 is not an object (got null).');
    },
    T,
  );
});

describe('r78 knowledge references --json and MCP get_knowledge_references return ONE listing', () => {
  test(
    'the usable references plus every malformed item — deep-equal across the two surfaces',
    async () => {
      const root = referencesFixture();
      const text = shrk(root, ['knowledge', 'references', 'doc.guide']);
      expect(text.status).toBe(0);
      expect(text.stdout).toContain('symbol: Foo@src/a.ts');
      expect(text.stdout).toContain('✗ reference #2: null — is not an object (got null)');

      const cli = JSON.parse(shrk(root, ['knowledge', 'references', 'doc.guide', '--json']).stdout) as {
        references: unknown[];
        malformed: { field: string; position?: number; value: unknown; problem: string }[];
      };
      expect(cli.references).toEqual([{ kind: 'symbol', symbol: 'Foo', path: 'src/a.ts' }]);
      expect(cli.malformed).toEqual([
        { field: 'references', position: 2, value: null, problem: 'is not an object (got null)' },
      ]);

      const inspection = await inspectSharkcraft({ cwd: root });
      const tool = ALL_TOOLS.find((t) => t.name === 'get_knowledge_references');
      expect(tool).toBeDefined();
      const res = await tool!.handler({ id: 'doc.guide' }, { inspection, cwd: root });
      expect(JSON.parse(JSON.stringify(res.data))).toEqual(cli);

      // A whole non-list value: listed as one malformed claim on both surfaces.
      const obj = JSON.parse(shrk(root, ['knowledge', 'references', 'k.obj', '--json']).stdout) as {
        malformed: { field: string; position?: number }[];
      };
      expect(obj.malformed).toEqual([expect.objectContaining({ field: 'references' })]);
      expect(obj.malformed[0]!.position).toBeUndefined();
      const resObj = await tool!.handler({ id: 'k.obj' }, { inspection, cwd: root });
      expect(JSON.parse(JSON.stringify(resObj.data))).toEqual(obj);
    },
    T,
  );
});

describe('r78 a malformed anchors value is reported, never a crash', () => {
  function anchorsFixture(): string {
    return tree('shrk-r78-claims-anchors-', {
      'sharkcraft/knowledge.ts':
        'export default [\n' +
        `  ${entry('k.ok', "references: [{ kind: 'file', path: 'src/a.ts' }]")},\n` +
        `  ${entry('k.map', "references: [{ kind: 'file', path: 'src/a.ts' }], anchors: { id: 'x', kind: 'file', path: 'src/a.ts' }")},\n` +
        `  ${entry('k.nul', "references: [{ kind: 'file', path: 'src/a.ts' }], anchors: [null]")},\n` +
        '];\n',
      'sharkcraft/sharkcraft.config.ts': config(['knowledge.ts']),
    });
  }

  test(
    'stale-check: one INVALID row each, naming the anchor; doctor: invalid-anchor; knowledge anchors lists them; quality runs its knowledge item',
    () => {
      const root = anchorsFixture();
      const s = shrk(root, ['knowledge', 'stale-check']);
      expect(s.status).toBe(2);
      const rows = s.stdout.split('\n').filter((l) => l.includes('INVALID'));
      expect(rows.find((l) => l.includes('k.map → anchors'))).toContain(
        'malformed anchor: `anchors` must be a list (got an object)',
      );
      expect(rows.find((l) => l.includes('k.nul → anchor #1'))).toContain('malformed anchor: is not an object (got null).');

      const d = shrk(root, ['doctor']);
      expect(d.status).toBe(1);
      expect(d.stdout).toContain('invalid-anchor');

      const a = shrk(root, ['knowledge', 'anchors', '--json']);
      expect(a.status).toBe(0);
      const listed = JSON.parse(a.stdout) as { count: number; malformed?: { entryId: string; at: string }[] };
      expect(listed.count).toBe(0);
      expect(listed.malformed?.map((m) => [m.entryId, m.at])).toEqual([
        ['k.map', '`anchors`'],
        ['k.nul', 'anchor #1'],
      ]);

      const q = shrk(root, ['quality', '--json']);
      const run = JSON.parse(q.stdout) as { items: { id: string; notes: string[] }[] };
      const item = run.items.find((i) => i.id === 'knowledge-stale');
      expect(item).toBeDefined();
      expect(item!.notes.join('\n')).not.toContain('could not run');
    },
    T,
  );
});
