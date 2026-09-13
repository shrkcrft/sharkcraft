/**
 * Round 11, 4.1 — a reference asserts what its target CONTAINS, not only that
 * it exists: `contains` / `matches` (zoned by `scan`), `count` (re-derived by
 * the extraction DSL), `Owner.member` symbols, and a failure mode per break.
 *
 * Real fixture through the real config loader + inspector.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { KnowledgeAdvisoryCode } from '../knowledge-advisory-code.ts';
import {
  buildKnowledgeStaleReport,
  ReferenceCheckOutcome,
  type IKnowledgeStaleReport,
} from '../knowledge-stale.ts';
import { ReferenceFailure } from '../reference-failure.ts';
import { warmReferenceRegistries } from '../reference-registry.ts';
import { inspectSharkcraft } from '../sharkcraft-inspector.ts';

const root = mkdtempSync(join(tmpdir(), 'shrk-r75-content-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const FOO = `// NOTE: legacyMode was removed — this comment only mentions it.
export class Foo {
  bar(): string { return 'hello-world'; }
}
export function baz(): number { return 42; }
export enum Color { Red, Green, Blue }
`;

function e(id: string, refs: string, content = 'x'): string {
  return (
    `{ id: '${id}', title: '${id}', type: 'technical', priority: 'medium', scope: [], tags: [], ` +
    `appliesWhen: [], content: ${JSON.stringify(content)}, references: ${refs} }`
  );
}

const ENTRIES = [
  e('c.contains-ok', "[{ kind: 'file', path: 'src/foo.ts', contains: 'hello-world' }]"),
  e('c.contains-fail', "[{ kind: 'file', path: 'src/foo.ts', contains: 'goodbye' }]"),
  e('c.scan-code', "[{ kind: 'file', path: 'src/foo.ts', contains: 'legacyMode', scan: 'code' }]"),
  e('c.scan-all', "[{ kind: 'file', path: 'src/foo.ts', contains: 'legacyMode' }]"),
  e('c.matches-ok', "[{ kind: 'file', path: 'src/foo.ts', matches: '^export enum Color' }]"),
  e(
    'c.count-enum',
    "[{ kind: 'file', path: 'src/foo.ts', count: { source: { files: ['src/foo.ts'], extract: 'enum-members', anchor: 'Color' }, expected: 2 } }]",
  ),
  e(
    'c.count-pattern',
    "[{ kind: 'directory', path: 'src/handlers', count: { source: { files: ['src/handlers/*.ts'], pattern: 'export const (HANDLER_\\\\w+)' }, expected: 2 } }]",
  ),
  e(
    'c.count-empty',
    "[{ kind: 'directory', path: 'src', count: { source: { files: ['nowhere/*.ts'], pattern: '(x)' }, expected: 0 } }]",
  ),
  e('c.path-missing', "[{ kind: 'file', path: 'src/gone.ts' }]"),
  e('c.anchor-missing', "[{ kind: 'symbol', symbol: 'nope', path: 'src/foo.ts' }]"),
  e('c.sym-file-missing', "[{ kind: 'symbol', symbol: 'Foo', path: 'src/gone.ts' }]"),
  e('c.member', "[{ kind: 'symbol', symbol: 'Foo.bar', path: 'src/foo.ts' }]"),
  e('c.bare-member', "[{ kind: 'symbol', symbol: 'bar', path: 'src/foo.ts' }]"),
  e('c.span-miss', "[{ kind: 'symbol', symbol: 'baz', path: 'src/foo.ts', contains: 'hello-world' }]"),
  e('c.span-hit', "[{ kind: 'symbol', symbol: 'baz', path: 'src/foo.ts', contains: '42' }]"),
  e('c.path-only', "[{ kind: 'file', path: 'src/foo.ts' }]", 'Call `baz()` to get the answer.'),
];

let report: IKnowledgeStaleReport;
beforeAll(async () => {
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'cfx', version: '0.0.0' }),
    'src/foo.ts': FOO,
    'src/handlers/h1.ts': 'export const HANDLER_ONE = 1;\n',
    'src/handlers/h2.ts': 'export const HANDLER_TWO = 2;\n',
    'sharkcraft/knowledge.ts': `export default [\n  ${ENTRIES.join(',\n  ')}\n];\n`,
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'cfx', knowledgeFiles: ['knowledge.ts'] };\n",
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  const insp = await inspectSharkcraft({ cwd: root });
  await warmReferenceRegistries(insp);
  report = buildKnowledgeStaleReport(insp);
});

function check(id: string) {
  const c = report.referenceChecks.find((x) => x.entryId === id);
  if (!c) throw new Error(`no check for ${id}`);
  return c;
}

describe('contains / matches', () => {
  test('a literal that still holds is ok; one that does not reports expected vs actual', () => {
    expect(check('c.contains-ok').outcome).toBe(ReferenceCheckOutcome.Ok);
    expect(check('c.matches-ok').outcome).toBe(ReferenceCheckOutcome.Ok);
    expect(check('c.contains-fail')).toMatchObject({
      outcome: ReferenceCheckOutcome.Stale,
      failure: ReferenceFailure.ContentMismatch,
      expected: 'contains "goodbye"',
      actual: 'not found',
    });
  });

  test("scan: 'code' — a comment that merely mentions it does not satisfy the claim", () => {
    expect(check('c.scan-code').failure).toBe(ReferenceFailure.ContentMismatch);
    expect(check('c.scan-all').outcome).toBe(ReferenceCheckOutcome.Ok);
  });

  test('on a pinned symbol, contains reads the DECLARATION span, not the file', () => {
    expect(check('c.span-miss').failure).toBe(ReferenceFailure.ContentMismatch);
    expect(check('c.span-hit').outcome).toBe(ReferenceCheckOutcome.Ok);
  });
});

describe('count — re-derived by the extraction DSL', () => {
  test('an enum that grew a member: count-mismatch, with the actual number to paste', () => {
    expect(check('c.count-enum')).toMatchObject({
      outcome: ReferenceCheckOutcome.Stale,
      failure: ReferenceFailure.CountMismatch,
      expected: 2,
      actual: 3,
    });
    expect(check('c.count-enum').message).toContain('set expected: 3');
  });

  test('a pattern over a glob that still matches the claim is ok', () => {
    expect(check('c.count-pattern')).toMatchObject({ outcome: ReferenceCheckOutcome.Ok, expected: 2, actual: 2 });
  });

  test('a count whose source matched 0 files measured nothing — unverifiable, even for expected 0', () => {
    expect(check('c.count-empty')).toMatchObject({
      outcome: ReferenceCheckOutcome.Unknown,
      failure: ReferenceFailure.Unverifiable,
    });
  });
});

describe('a failure mode per break (outcome kept for back-compat)', () => {
  test('a missing file is path-missing — and still outcome stale', () => {
    expect(check('c.path-missing')).toMatchObject({
      outcome: ReferenceCheckOutcome.Stale,
      failure: ReferenceFailure.PathMissing,
    });
  });

  test('a missing symbol in an existing file is anchor-missing; in a missing file, path-missing', () => {
    expect(check('c.anchor-missing').failure).toBe(ReferenceFailure.AnchorMissing);
    expect(check('c.sym-file-missing')).toMatchObject({
      outcome: ReferenceCheckOutcome.Missing,
      failure: ReferenceFailure.PathMissing,
    });
  });

  test('failure counts add up across the report', () => {
    expect(report.failureCounts[ReferenceFailure.PathMissing]).toBe(2);
    expect(report.failureCounts[ReferenceFailure.CountMismatch]).toBe(1);
  });
});

describe('Owner.member symbols', () => {
  test('a member reference resolves', () => {
    expect(check('c.member').outcome).toBe(ReferenceCheckOutcome.Ok);
  });

  test('a bare member name is stale, and the fix is the qualified spelling', () => {
    const c = check('c.bare-member');
    expect(c.failure).toBe(ReferenceFailure.AnchorMissing);
    expect(c.replaceWith?.symbol).toBe('Foo.bar');
  });
});

describe('the path-only advisory', () => {
  test('an entry naming an exported symbol of its only-referenced file is steered to the strong form', () => {
    const adv = report.advisories.find(
      (a) => a.code === KnowledgeAdvisoryCode.PathOnlyReference && a.subjectId === 'c.path-only',
    );
    expect(adv?.suggestion).toEqual({ kind: 'symbol', symbol: 'baz', path: 'src/foo.ts' });
  });
});
