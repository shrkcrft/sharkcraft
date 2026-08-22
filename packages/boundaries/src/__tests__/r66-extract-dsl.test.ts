/**
 * The extraction DSL — the reusable core of the completeness plane.
 *
 * Each extractor kind is tested against the shape it exists to read, plus the
 * shapes that historically defeat a naive regex: a wrapped array literal
 * (`Object.freeze([…])`), a section comment before an element, a nested literal
 * containing commas, and a re-export alias.
 */
import { describe, expect, test } from 'bun:test';
import type { IWiringSource } from '@shrkcrft/core';
import { extractTokens } from '../extract/extract-tokens.ts';

function ids(source: IWiringSource, content: string, path = 'src/a.ts'): string[] {
  const res = extractTokens(source, [{ path, content }]);
  expect(res.error).toBeUndefined();
  return res.sites.map((s) => s.token);
}

describe('extractTokens — array-members', () => {
  test('reads a plain array literal', () => {
    expect(ids({ files: ['**'], extract: 'array-members', anchor: 'PLUGINS' }, 'export const PLUGINS = [A, B, C];')).toEqual(['A', 'B', 'C']);
  });

  test('reads a typed + wrapped array (Object.freeze) — the common registry shape', () => {
    const src = 'export const ALL: readonly T[] = Object.freeze([\n  aTool,\n  bTool,\n]);';
    expect(ids({ files: ['**'], extract: 'array-members', anchor: 'ALL' }, src)).toEqual(['aTool', 'bTool']);
  });

  test('a section comment before an element does not swallow it', () => {
    const src = 'const R = [\n  a,\n  // grouped section\n  b,\n  /* block */ c,\n];';
    expect(ids({ files: ['**'], extract: 'array-members', anchor: 'R' }, src)).toEqual(['a', 'b', 'c']);
  });

  test('commas inside a nested literal or string never mis-split', () => {
    const src = "const R = [a, f({ x: 1, y: 2 }), 'lit,eral', [n1, n2]];";
    // A nested literal has no id of its own and contributes none — inventing
    // one from its first element would be a fabricated match.
    expect(ids({ files: ['**'], extract: 'array-members', anchor: 'R' }, src)).toEqual(['a', 'f', 'lit,eral']);
  });

  test('the `arrayProperty` sugar is exactly `array-members` with that anchor', () => {
    const src = 'const R = [a, b];';
    expect(ids({ files: ['**'], arrayProperty: 'R' }, src)).toEqual(
      ids({ files: ['**'], extract: 'array-members', anchor: 'R' }, src),
    );
  });

  test('the reported line is the element, not the array head', () => {
    const res = extractTokens(
      { files: ['**'], extract: 'array-members', anchor: 'R' },
      [{ path: 'src/a.ts', content: 'const R = [\n  a,\n  b,\n];' }],
    );
    expect(res.sites.map((s) => s.line)).toEqual([2, 3]);
  });
});

describe('extractTokens — object-keys / enum-members', () => {
  test('object-keys captures top-level keys only', () => {
    const src = "const MAP = {\n  alpha: 1,\n  'beta': { nested: 2 },\n};";
    expect(ids({ files: ['**'], extract: 'object-keys', anchor: 'MAP' }, src)).toEqual(['alpha', 'beta']);
  });

  test('object-keys with capture:value reads the assigned string', () => {
    const src = "const MAP = { alpha: 'a-id', beta: 'b-id' };";
    expect(
      ids({ files: ['**'], extract: 'object-keys', anchor: 'MAP', capture: 'value' }, src),
    ).toEqual(['a-id', 'b-id']);
  });

  test('enum-members captures member names by default and values on request', () => {
    const src = "export enum Kind {\n  First = 'first',\n  Second = 'second',\n}";
    expect(ids({ files: ['**'], extract: 'enum-members', anchor: 'Kind' }, src)).toEqual(['First', 'Second']);
    expect(
      ids({ files: ['**'], extract: 'enum-members', anchor: 'Kind', capture: 'value' }, src),
    ).toEqual(['first', 'second']);
  });
});

describe('extractTokens — export-names', () => {
  test('captures every exported declaration form', () => {
    const src = [
      'export const a = 1;',
      'export function b() {}',
      'export async function c() {}',
      'export class D {}',
      'export abstract class E {}',
      'export interface F {}',
      'export type G = string;',
      'export enum H {}',
    ].join('\n');
    expect(ids({ files: ['**'], extract: 'export-names' }, src)).toEqual(['a', 'b', 'c', 'D', 'E', 'F', 'G', 'H']);
  });

  test('a re-export clause reports the EXPORTED alias, not the local name', () => {
    const src = "export { local as Public, other } from './x.ts';\nexport type { T } from './y.ts';";
    expect(ids({ files: ['**'], extract: 'export-names' }, src)).toEqual(['Public', 'other', 'T']);
  });
});

describe('extractTokens — call-args / decorator-args', () => {
  test('captures the nth argument of a named call', () => {
    const src = "definePlugin('alpha', {});\ndefinePlugin('beta', {});";
    expect(ids({ files: ['**'], extract: 'call-args', anchor: 'definePlugin' }, src)).toEqual(['alpha', 'beta']);
  });

  test('a member call is addressed by its dotted anchor, not by accident', () => {
    const src = "registry.register(alphaCommand);\nother.register(betaCommand);";
    expect(ids({ files: ['**'], extract: 'call-args', anchor: 'registry.register' }, src)).toEqual(['alphaCommand']);
  });

  test('argIndex selects a later argument', () => {
    const src = "registerSubcommand('group', childCommand);";
    expect(
      ids({ files: ['**'], extract: 'call-args', anchor: 'registerSubcommand', argIndex: 1 }, src),
    ).toEqual(['childCommand']);
  });

  test('decorator-args reads @Anchor(...)', () => {
    const src = "@Injectable('token-a')\nclass A {}";
    expect(ids({ files: ['**'], extract: 'decorator-args', anchor: 'Injectable' }, src)).toEqual(['token-a']);
  });
});

describe('extractTokens — string-union-members / json-path', () => {
  test('string-union-members reads a multi-line union alias', () => {
    const src = "export type Kind =\n  | 'a'\n  | 'b'\n  | 'c';\nconst other = 'not-part';";
    expect(ids({ files: ['**'], extract: 'string-union-members', anchor: 'Kind' }, src)).toEqual(['a', 'b', 'c']);
  });

  test('json-path selects scalars through .key / [*] / [n]', () => {
    const doc = JSON.stringify({ symbols: [{ name: 'one' }, { name: 'two' }] });
    expect(
      ids({ files: ['**'], extract: 'json-path', jsonPath: 'symbols[*].name' }, doc, 'a.json'),
    ).toEqual(['one', 'two']);
    expect(
      ids({ files: ['**'], extract: 'json-path', jsonPath: '$.symbols[0].name' }, doc, 'a.json'),
    ).toEqual(['one']);
  });

  test('a selected object contributes its KEYS', () => {
    const doc = JSON.stringify({ paths: { '@a/*': ['a'], '@b/*': ['b'] } });
    expect(ids({ files: ['**'], extract: 'json-path', jsonPath: 'paths' }, doc, 'a.json')).toEqual(['@a/*', '@b/*']);
  });

  test('non-JSON content yields nothing rather than a bogus match', () => {
    expect(ids({ files: ['**'], extract: 'json-path', jsonPath: 'a' }, 'not json at all', 'a.json')).toEqual([]);
  });
});

describe('extractTokens — match / exclude filters', () => {
  const src = 'export const aTool = 1;\nexport const bHelper = 2;\nexport const cTool = 3;';

  test('match narrows to the ids that pass it', () => {
    expect(ids({ files: ['**'], extract: 'export-names', match: 'Tool$' }, src)).toEqual(['aTool', 'cTool']);
  });

  test('exclude drops ids after match — the allow/deny pair', () => {
    expect(
      ids({ files: ['**'], extract: 'export-names', match: 'Tool$', exclude: '^cTool$' }, src),
    ).toEqual(['aTool']);
  });
});

describe('extractTokens — misconfiguration never throws', () => {
  test('an anchored kind with no anchor is an error, not an exception', () => {
    const res = extractTokens({ files: ['**'], extract: 'array-members' }, []);
    expect(res.error).toContain('anchor');
    expect(res.sites).toEqual([]);
  });

  test('two DIFFERENT modes conflict; a kind alongside its own sugar does not', () => {
    expect(
      extractTokens({ files: ['**'], extract: 'object-keys', arrayProperty: 'X' }, []).error,
    ).toContain('arrayProperty');
    expect(
      extractTokens({ files: ['**'], extract: 'regex-capture', pattern: '(a)' }, []).error,
    ).toBeUndefined();
  });

  test('an uncompilable match filter is reported against `match`', () => {
    const res = extractTokens({ files: ['**'], extract: 'export-names', match: '([' }, []);
    expect(res.error).toContain('match');
  });
});
