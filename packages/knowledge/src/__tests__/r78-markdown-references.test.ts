/**
 * r78 — Markdown knowledge gets a references channel (round 15, 15.2).
 *
 * The Markdown loader mapped a fixed key set that had no `references`, and its
 * line splitter could not build objects, so a Markdown entry was ALWAYS
 * unverifiable (stale-check 2 → quality not-verified, with no remedy a pack
 * author could apply). It now reads a `references:` frontmatter list through
 * THE frontmatter parser (@shrkcrft/core) and THE reference grammar
 * (`parseReferenceSpec`, moved here from the CLI) into the SAME objects a
 * TypeScript entry declares — validated by the one validator.
 *
 * Real loaders over real files; no invented shapes.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KNOWLEDGE_REFERENCE_KINDS,
  KnowledgeIssueSeverity,
  MarkdownKnowledgeLoader,
  TypeScriptKnowledgeLoader,
  formatKnowledgeReference,
  knowledgeReferences,
  parseReferenceSpec,
  validateKnowledgeEntries,
  type IKnowledgeReference,
} from '../index.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function write(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'shrk-r78-md-'));
  roots.push(dir);
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
}

async function loadMd(frontmatter: string, body = '# Guide\n\nBody.\n') {
  return new MarkdownKnowledgeLoader().load(write('guide.md', `---\n${frontmatter}\n---\n${body}`));
}

/** What the same references look like declared in TypeScript, through the REAL TS loader. */
async function tsReferences(literal: string): Promise<readonly IKnowledgeReference[]> {
  const p = write(
    'knowledge.ts',
    `export default [{ id: 'k.a', title: 'A', type: 'technical', priority: 'medium', content: 'x', references: ${literal} }];\n`,
  );
  const r = await new TypeScriptKnowledgeLoader().load(p);
  return r.entries[0]!.references ?? [];
}

describe('r78 accepted shapes — each deep-equals the equivalent TypeScript literal', () => {
  const TS_LITERAL =
    "[{ kind: 'file', path: 'src/a.ts' }, { kind: 'symbol', symbol: 'Foo', path: 'src/foo.ts' }, { kind: 'template', id: 'app.service', required: true }]";

  const SHAPES: Record<string, string> = {
    'a list of maps': [
      'references:',
      '  - kind: file',
      '    path: src/a.ts',
      '  - kind: symbol',
      '    symbol: Foo',
      '    path: src/foo.ts',
      '  - kind: template',
      '    id: app.service',
      '    required: true',
    ].join('\n'),
    'an inline list of --reference strings': 'references: [file:src/a.ts, "symbol:Foo@src/foo.ts", template:app.service:required]',
    'block `- kind:value` items (the compact form)': [
      'references:',
      '  - file:src/a.ts',
      '  - symbol:Foo@src/foo.ts',
      '  - template:app.service:required',
    ].join('\n'),
    'quoted block strings': [
      'references:',
      '  - "file:src/a.ts"',
      "  - 'symbol:Foo@src/foo.ts'",
      '  - "template:app.service:required"',
    ].join('\n'),
  };

  for (const [name, fm] of Object.entries(SHAPES)) {
    test(name, async () => {
      const md = await loadMd(`id: doc.guide\n${fm}`);
      expect(md.rejected).toEqual([]);
      expect(md.warnings).toEqual([]);
      expect(md.entries[0]!.references).toEqual(await tsReferences(TS_LITERAL));
    });
  }

  test('content assertions carry through (contains / matches / scan)', async () => {
    const md = await loadMd(
      [
        'references:',
        '  - kind: file',
        '    path: src/a.ts',
        '    contains: "export class Foo"',
        "    matches: '^export\\s+class'",
        '    scan: code',
      ].join('\n'),
    );
    expect(md.entries[0]!.references).toEqual(
      await tsReferences("[{ kind: 'file', path: 'src/a.ts', contains: 'export class Foo', matches: '^export\\\\s+class', scan: 'code' }]"),
    );
  });
});

describe('r78 the reference grammar — parseReferenceSpec lives next to its inverse', () => {
  const value = (kind: string): string =>
    kind === 'file' ? 'src/a.ts' : kind === 'directory' ? 'src' : kind === 'url' ? 'https://example.com/x' : `${kind}.id`;

  test('formatKnowledgeReference(parseReferenceSpec(s)) === s for every kind (`:required` is a flag, never rendered)', () => {
    for (const kind of KNOWLEDGE_REFERENCE_KINDS) {
      const s = `${kind}:${value(kind)}`;
      const ref = parseReferenceSpec(s);
      expect(ref).not.toBeNull();
      expect(formatKnowledgeReference(ref!)).toBe(s);
      expect(parseReferenceSpec(`${s}:required`)?.required).toBe(true);
    }
    for (const s of ['symbol:Foo@src/foo.ts', 'symbol:Owner.member@src/foo.ts']) {
      expect(formatKnowledgeReference(parseReferenceSpec(s)!)).toBe(s);
    }
  });
});

describe('r78 an indented block never overrides the entry\'s top-level fields', () => {
  test('metadata: with nested title / type / priority — the entry keeps its own (U2)', async () => {
    const md = await loadMd(
      ['id: doc.guide', 'title: Guide', 'metadata:', '  title: Overridden title', '  type: rule', '  priority: critical'].join('\n'),
    );
    const e = md.entries[0]!;
    expect(e.id).toBe('doc.guide');
    expect(e.title).toBe('Guide');
    expect(e.type).toBe('technical');
    expect(e.priority).toBe('medium');
    expect(md.warnings.some((w) => w.includes('"metadata" was dropped'))).toBe(true);
  });

  test('a references: item carrying `id:` never becomes the entry id', async () => {
    const md = await loadMd(['title: Guide', 'references:', '  - kind: template', '    id: app.service'].join('\n'));
    expect(md.entries[0]!.id).toBe('doc.guide');
    expect(md.entries[0]!.references).toEqual([{ kind: 'template', id: 'app.service' }]);
  });

  test('a dropped key in YAML the parser does not speak still only warns — it never costs the document', async () => {
    const md = await loadMd(['id: doc.guide', 'description: >-', '  folded text', '  more', 'owner: team a'].join('\n'));
    expect(md.rejected).toEqual([]);
    expect(md.entries[0]!.id).toBe('doc.guide');
    expect(md.warnings).toHaveLength(2);
  });
});

describe('r78 refusals — loud, through the rejected channel (accepted + rejected = declared)', () => {
  const REFUSED: Record<string, { fm: string; reason: string }> = {
    'mixed string and map items': {
      fm: ['id: doc.x', 'references:', '  - "file:src/a.ts"', '  - kind: file', '    path: src/b.ts'].join('\n'),
      reason: 'mixed string and map items in one list',
    },
    'a nested count.source': {
      fm: [
        'id: doc.x',
        'references:',
        '  - kind: directory',
        '    path: src',
        '    count:',
        '      source:',
        '        files: [src/**/*.ts]',
        '      expected: 3',
      ].join('\n'),
      reason: 'declare this entry in TypeScript',
    },
    'a one-level count': {
      fm: ['id: doc.x', 'references:', '  - kind: directory', '    path: src', '    count: 3'].join('\n'),
      reason: 'references[0].count: nested selectors are not supported in Markdown frontmatter — declare this entry in TypeScript',
    },
    'a flow map': {
      fm: ['id: doc.x', 'references: [{ kind: file, path: src/a.ts }]'].join('\n'),
      reason: 'references[0]: a flow map ({ … }) is not supported',
    },
    'truly unparseable frontmatter': {
      fm: ['id: doc.x', 'this line names no key'].join('\n'),
      reason: 'frontmatter: Expected "<key>:" at line 3',
    },
    'a field of the wrong shape': {
      fm: ['id: doc.x', 'title:', '  - a', '  - b'].join('\n'),
      reason: 'title: must be a single value (got a list)',
    },
  };

  for (const [name, c] of Object.entries(REFUSED)) {
    test(name, async () => {
      const md = await loadMd(c.fm);
      expect(md.entries).toEqual([]);
      expect(md.rejected).toHaveLength(1);
      const r = md.rejected![0]!;
      expect(r.entryId).toBe('doc.x');
      expect(r.index).toBe(-1);
      expect(r.reasons.join(' | ')).toContain(c.reason);
    });
  }
});

describe('r78 invalid input takes the SAME path as TypeScript', () => {
  test('a shape-invalid item passes through to THE validator — invalid-reference, like the TS literal', async () => {
    const md = await loadMd(['id: doc.guide', 'references:', '  - kind: bogus', '    path: src/a.ts', '  - bogus:x'].join('\n'));
    expect(md.rejected).toEqual([]);
    const mdIssues = validateKnowledgeEntries(md.entries).issues.filter((i) => i.code === 'invalid-reference');
    const ts = await new TypeScriptKnowledgeLoader().load(
      write('k.ts', "export default [{ id: 'doc.guide', title: 'G', type: 'technical', content: 'x', references: [{ kind: 'bogus', path: 'src/a.ts' }] }];\n"),
    );
    const tsIssues = validateKnowledgeEntries(ts.entries).issues.filter((i) => i.code === 'invalid-reference');
    expect(mdIssues[0]!.message).toBe(tsIssues[0]!.message);
    expect(mdIssues[1]!.message).toContain('"bogus:x", which is not a reference spec');
    expect(mdIssues[1]!.message).toContain('unknown kind "bogus"');
  });

  test('a non-list references value is kept and reported — never a crash (TS and Markdown alike)', async () => {
    const md = await loadMd(['id: doc.guide', 'references: src/a.ts'].join('\n'));
    expect(md.rejected).toEqual([]);
    expect(md.entries[0]!.references as unknown).toBe('src/a.ts');
    const ts = await new TypeScriptKnowledgeLoader().load(
      write('k.ts', "export default [{ id: 'k.x', title: 'X', type: 'technical', content: 'x', references: { kind: 'file', path: 'src/a.ts' } }];\n"),
    );
    for (const entries of [md.entries, ts.entries]) {
      const v = validateKnowledgeEntries(entries);
      expect(v.uniqueEntries).toHaveLength(1);
      const issue = v.issues.find((i) => i.code === 'invalid-reference');
      expect(issue?.severity).toBe(KnowledgeIssueSeverity.Error);
      expect(issue?.message).toContain('`references` must be a list');
      expect(knowledgeReferences(entries[0]!)).toEqual([]);
    }
    expect(validateKnowledgeEntries(md.entries).issues[0]!.message).toContain('references: [file:src/a.ts]');
  });
});
