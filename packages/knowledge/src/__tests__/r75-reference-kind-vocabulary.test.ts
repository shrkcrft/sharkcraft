/**
 * Round 11 §3.2 — KNOWLEDGE_REFERENCE_KINDS is THE reference-kind vocabulary:
 * the validator, the stale-check and the authoring grammar all read it.
 *
 * Property: every kind in the vocabulary, with the field it cannot be checked
 * without, validates clean; each one missing that field raises exactly one
 * warning naming the field; an absolute path is a warning (repo-relative only);
 * an unknown kind is an error listing the whole vocabulary.
 */
import { describe, expect, test } from 'bun:test';
import {
  KNOWLEDGE_REFERENCE_KINDS,
  type IKnowledgeEntry,
  type IKnowledgeReference,
  type KnowledgeReferenceKind,
} from '../model/knowledge-entry.ts';
import { validateKnowledgeEntries } from '../validate/validate-knowledge-entries.ts';

const SHAPE_CODES = new Set(['invalid-reference', 'reference-absolute-path']);

function issuesFor(refs: readonly unknown[]): { code: string; severity: string; message: string }[] {
  const entry = {
    id: 'k.refs',
    title: 'Refs',
    type: 'technical',
    priority: 'medium',
    scope: [],
    tags: [],
    appliesWhen: [],
    content: 'x',
    references: refs,
  } as unknown as IKnowledgeEntry;
  return validateKnowledgeEntries([entry])
    .issues.filter((i) => SHAPE_CODES.has(i.code))
    .map((i) => ({ code: i.code, severity: i.severity, message: i.message }));
}

/** A reference of `kind` carrying the one field its kind cannot be checked without. */
function wellFormed(kind: KnowledgeReferenceKind): IKnowledgeReference {
  if (kind === 'file') return { kind, path: 'src/a.ts' };
  if (kind === 'directory') return { kind, path: 'src' };
  if (kind === 'symbol') return { kind, symbol: 'A', path: 'src/a.ts' };
  if (kind === 'command') return { kind, command: 'shrk doctor' };
  return { kind, id: kind === 'url' ? 'https://example.com' : 'some.id' };
}

/** The same reference with its required field removed (`url` has none). */
function stripped(kind: KnowledgeReferenceKind): { ref: IKnowledgeReference; field: string } | null {
  if (kind === 'url') return null;
  if (kind === 'file' || kind === 'directory') return { ref: { kind }, field: 'path' };
  if (kind === 'symbol') return { ref: { kind, path: 'src/a.ts' }, field: 'symbol' };
  if (kind === 'command') return { ref: { kind }, field: 'command' };
  return { ref: { kind }, field: 'id' };
}

describe('the vocabulary is the validator', () => {
  test('every kind, well-formed, raises nothing', () => {
    for (const kind of KNOWLEDGE_REFERENCE_KINDS) {
      expect({ kind, issues: issuesFor([wellFormed(kind)]) }).toEqual({ kind, issues: [] });
    }
  });

  test('every kind missing its required field raises ONE warning naming the field', () => {
    for (const kind of KNOWLEDGE_REFERENCE_KINDS) {
      const s = stripped(kind);
      if (!s) continue;
      const issues = issuesFor([s.ref]);
      expect({ kind, n: issues.length, code: issues[0]?.code, severity: issues[0]?.severity }).toEqual({
        kind,
        n: 1,
        code: 'invalid-reference',
        severity: 'warning',
      });
      expect(issues[0]?.message).toContain(s.field);
    }
  });

  test('a kind outside the vocabulary is an error that lists every kind', () => {
    const issues = issuesFor([{ kind: 'bogus-kind', path: 'x' }]);
    expect(issues.map((i) => [i.code, i.severity])).toEqual([['invalid-reference', 'error']]);
    for (const kind of KNOWLEDGE_REFERENCE_KINDS) expect(issues[0]?.message).toContain(kind);
  });
});

describe('reference paths are repo-relative', () => {
  test('a leading slash or a drive letter is a warning with the relative spelling', () => {
    for (const [path, fixed] of [
      ['/src/a.ts', 'src/a.ts'],
      ['C:\\src\\a.ts', 'src\\a.ts'],
    ] as const) {
      const issues = issuesFor([{ kind: 'file', path }]);
      expect(issues.map((i) => [i.code, i.severity])).toEqual([['reference-absolute-path', 'warning']]);
      expect(issues[0]?.message).toContain(`write "${fixed}"`);
    }
  });

  test('a relative path (and a directory, and a pinned symbol) raises nothing', () => {
    expect(
      issuesFor([
        { kind: 'file', path: 'src/a.ts' },
        { kind: 'directory', path: './src' },
        { kind: 'symbol', symbol: 'A', path: 'src/a.ts' },
      ]),
    ).toEqual([]);
  });
});
