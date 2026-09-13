/**
 * r78 — a reference's `root` (round 15 follow-up, F7): `root: pack` resolves a
 * pack's path against the contributing pack's package directory. The ONE `root`
 * predicate is shared by the validator and the stale-check; this locks the
 * validator half and the Markdown map-item grammar (the compact string grammar
 * is unchanged). The stale-check half is locked in the inspector's
 * r78-pack-reference-root test.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeReferenceRoot } from '@shrkcrft/core';
import { formatKnowledgeReference, parseReferenceSpec } from '../format/knowledge-reference-format.ts';
import { MarkdownKnowledgeLoader } from '../load/markdown-knowledge-loader.ts';
import type { IKnowledgeEntry } from '../model/knowledge-entry.ts';
import { KnowledgeIssueSeverity } from '../validate/knowledge-issue-severity.ts';
import { referenceRootProblem } from '../validate/reference-root-problem.ts';
import { validateKnowledgeEntries } from '../validate/validate-knowledge-entries.ts';

function entry(id: string, references: unknown): IKnowledgeEntry {
  return {
    id,
    title: id,
    type: 'technical',
    priority: 'medium',
    scope: [],
    tags: [],
    appliesWhen: [],
    content: 'x',
    references: references as IKnowledgeEntry['references'],
  };
}

describe('r78 referenceRootProblem — THE root predicate', () => {
  test('absent and project are fine anywhere; pack is fine on a pack entry with a path or a count', () => {
    expect(referenceRootProblem({ kind: 'file', path: 'a.md' }, false)).toBeUndefined();
    expect(referenceRootProblem({ kind: 'file', path: 'a.md', root: KnowledgeReferenceRoot.Project }, false)).toBeUndefined();
    expect(referenceRootProblem({ kind: 'file', path: 'a.md', root: KnowledgeReferenceRoot.Pack }, true)).toBeUndefined();
    expect(
      referenceRootProblem(
        { kind: 'directory', path: 'src', root: 'pack', count: { source: { files: ['src/*.ts'], pattern: 'x' }, expected: 1 } },
        true,
      ),
    ).toBeUndefined();
  });

  test('root: pack on an entry no pack contributes is an ERROR — never a silent fallback to the project root', () => {
    const p = referenceRootProblem({ kind: 'file', path: 'docs/guide.md', root: 'pack' }, false);
    expect(p?.severity).toBe(KnowledgeIssueSeverity.Error);
    expect(p?.message).toContain('no pack contributes this entry');
  });

  test('an unknown root value is an error naming the vocabulary', () => {
    const p = referenceRootProblem({ kind: 'file', path: 'a.md', root: 'package' }, true);
    expect(p?.severity).toBe(KnowledgeIssueSeverity.Error);
    expect(p?.message).toContain('expected one of: project, pack');
    expect(referenceRootProblem({ kind: 'file', path: 'a.md', root: 42 }, true)?.severity).toBe(KnowledgeIssueSeverity.Error);
  });

  test('root: pack with nothing path-based to resolve is a warning (no effect)', () => {
    const p = referenceRootProblem({ kind: 'template', id: 'x.y', root: 'pack' }, true);
    expect(p?.severity).toBe(KnowledgeIssueSeverity.Warning);
    expect(p?.message).toContain('no effect');
  });
});

describe('r78 validateKnowledgeEntries — root: pack is valid only on a pack-contributed entry', () => {
  const local = entry('k.local', [{ kind: 'file', path: 'docs/guide.md', root: 'pack' }]);
  const fromPack = entry('k.pack', [{ kind: 'file', path: 'docs/guide.md', root: 'pack' }]);

  test('default (no provenance): root: pack is an invalid-reference error that KEEPS the entry', () => {
    const r = validateKnowledgeEntries([local]);
    expect(r.valid).toBe(false);
    expect(r.uniqueEntries.map((e) => e.id)).toEqual(['k.local']);
    const issue = r.issues.find((i) => i.entryId === 'k.local');
    expect(issue).toMatchObject({ code: 'invalid-reference', severity: 'error' });
    expect(issue?.message).toContain('reference #1 (file) sets root: pack, but no pack contributes this entry');
  });

  test('isPackContributed: the pack entry passes, the local one still fails', () => {
    const r = validateKnowledgeEntries([local, fromPack], { isPackContributed: (e) => e.id === 'k.pack' });
    expect(r.issues.filter((i) => i.entryId === 'k.pack')).toEqual([]);
    expect(r.issues.filter((i) => i.entryId === 'k.local').map((i) => i.severity)).toEqual([KnowledgeIssueSeverity.Error]);
  });

  test('an unknown root is an error on a pack entry too', () => {
    const r = validateKnowledgeEntries([entry('k.bad', [{ kind: 'file', path: 'a.md', root: 'consumer' }])], {
      isPackContributed: () => true,
    });
    expect(r.issues.map((i) => [i.code, i.severity])).toEqual([['invalid-reference', KnowledgeIssueSeverity.Error]]);
  });
});

describe('r78 Markdown: a map item accepts root: pack; the compact grammar is unchanged', () => {
  test('a map item with root: pack deep-equals the TypeScript literal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shrk-r78-root-md-'));
    try {
      const file = join(dir, 'guide.md');
      writeFileSync(
        file,
        '---\nid: pack.guide\nreferences:\n  - kind: file\n    path: docs/guide.md\n    root: pack\n  - kind: symbol\n    symbol: Foo\n    path: src/foo.ts\n    contains: "export class Foo"\n    root: pack\n---\n# Guide\n',
      );
      const r = await new MarkdownKnowledgeLoader().load(file);
      expect(r.rejected ?? []).toEqual([]);
      expect(r.entries[0]?.references).toEqual([
        { kind: 'file', path: 'docs/guide.md', root: KnowledgeReferenceRoot.Pack },
        { kind: 'symbol', symbol: 'Foo', path: 'src/foo.ts', contains: 'export class Foo', root: KnowledgeReferenceRoot.Pack },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the compact grammar carries no root: `file:x` round-trips unchanged and renders without it', () => {
    expect(parseReferenceSpec('file:docs/guide.md')).toEqual({ kind: 'file', path: 'docs/guide.md' });
    expect(formatKnowledgeReference({ kind: 'file', path: 'docs/guide.md', root: KnowledgeReferenceRoot.Pack })).toBe(
      'file:docs/guide.md',
    );
  });
});
