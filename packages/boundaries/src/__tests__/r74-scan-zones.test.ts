/**
 * Round 74 — lexical zoning for the extraction DSL.
 *
 * Every content-reading extractor used to run against file BYTES, so a pattern
 * keyed on a code construct also fired on a doc comment DESCRIBING it (a false
 * failure) and a count extractor counted words inside prose (a false green — a
 * real regression hides under a padded count). `scan` is the fix, and these
 * are the properties that must not regress:
 *
 *   1. the four-way fixture splits cleanly by zone;
 *   2. the code match reports the SAME line under `all` and `code` (blanking
 *      preserves offsets — the whole reason it blanks instead of deleting);
 *   3. zoning reaches EVERY extractor kind, not just `regex-capture`;
 *   4. an inapplicable or misspelled zone is an ERROR, never a silent no-op —
 *      a dropped zone is a rule that reads stricter than it is.
 */
import { describe, expect, test } from 'bun:test';
import type { IWiringSource, ScanZone } from '@shrkcrft/core';
import { blankOutsideZone } from '../extract/code-zones.ts';
import { extractTokens } from '../extract/extract-tokens.ts';

const FIXTURE = [
  'const node = mk<Foo>();',
  '// const node = mk<Foo>()',
  '/* mk<Foo>() appears here too */',
  'const doc = "call mk<Foo>() to build one";',
].join('\n');

function sites(scan: ScanZone | undefined, content = FIXTURE): { token: string; line: number }[] {
  const source: IWiringSource = {
    files: ['**'],
    extract: 'regex-capture',
    pattern: '(mk<Foo>)',
    ...(scan ? { scan } : {}),
  };
  const res = extractTokens(source, [{ path: 'src/a.ts', content }]);
  expect(res.error).toBeUndefined();
  return res.sites.map((s) => ({ token: s.token, line: s.line }));
}

describe('scan zones — the four-way fixture', () => {
  test('all (the default) matches every zone', () => {
    expect(sites(undefined).map((s) => s.line)).toEqual([1, 2, 3, 4]);
    expect(sites('all').map((s) => s.line)).toEqual([1, 2, 3, 4]);
  });

  test('code sees only real code', () => {
    expect(sites('code').map((s) => s.line)).toEqual([1]);
  });

  test('comments sees both comment forms', () => {
    expect(sites('comments').map((s) => s.line)).toEqual([2, 3]);
  });

  test('strings sees only the string literal', () => {
    expect(sites('strings').map((s) => s.line)).toEqual([4]);
  });

  test('the zones partition the match set — no hit is lost or double-counted', () => {
    const all = sites('all').length;
    expect(sites('code').length + sites('comments').length + sites('strings').length).toBe(all);
  });
});

describe('offsets survive blanking', () => {
  test('the code match reports the same line under all and code', () => {
    const underAll = sites('all').find((s) => s.line === 1);
    const underCode = sites('code')[0];
    expect(underCode).toEqual(underAll!);
  });

  test('blanking preserves length and newlines', () => {
    const blanked = blankOutsideZone(FIXTURE, 'code');
    expect(blanked.content.length).toBe(FIXTURE.length);
    expect(blanked.content.split('\n').length).toBe(FIXTURE.split('\n').length);
    expect(blanked.blankedChars).toBeGreaterThan(0);
  });

  test('the blanked-character count is reported, not merely applied', () => {
    // A zone is the one setting that makes a rule match LESS while still
    // reading green; the amount removed must be visible to the author.
    expect(extractTokens({ files: ['**'], extract: 'regex-capture', pattern: '(mk<Foo>)' }, [
      { path: 'a.ts', content: FIXTURE },
    ]).blankedChars).toBeUndefined();
    expect(
      extractTokens({ files: ['**'], extract: 'regex-capture', pattern: '(mk<Foo>)', scan: 'code' }, [
        { path: 'a.ts', content: FIXTURE },
      ]).blankedChars,
    ).toBeGreaterThan(0);
  });
});

describe('code-and-templates — the embedded-DSL escape hatch', () => {
  const src = [
    'const a = run(ALPHA);',
    '// const b = run(BETA);',
    'const c = "run(GAMMA)";',
    'const d = sql`run(DELTA)`;',
  ].join('\n');

  test('code blanks the template body along with every other string', () => {
    const res = extractTokens(
      { files: ['**'], extract: 'call-args', anchor: 'run', scan: 'code' },
      [{ path: 'a.ts', content: src }],
    );
    expect(res.sites.map((s) => s.token)).toEqual(['ALPHA']);
  });

  test('code-and-templates keeps backtick bodies but still drops comments and quoted strings', () => {
    const res = extractTokens(
      { files: ['**'], extract: 'call-args', anchor: 'run', scan: 'code-and-templates' },
      [{ path: 'a.ts', content: src }],
    );
    expect(res.sites.map((s) => s.token)).toEqual(['ALPHA', 'DELTA']);
  });
});

describe('zoning reaches every content extractor, not just regex-capture', () => {
  test('array-members ignores a commented-out registry', () => {
    const src = ['const TOOLS = [alpha, beta];', '// const TOOLS = [gamma, delta];'].join('\n');
    const zoned = extractTokens(
      { files: ['**'], extract: 'array-members', anchor: 'TOOLS', scan: 'code' },
      [{ path: 'a.ts', content: src }],
    );
    expect(zoned.sites.map((s) => s.token)).toEqual(['alpha', 'beta']);
    const unzoned = extractTokens(
      { files: ['**'], extract: 'array-members', anchor: 'TOOLS' },
      [{ path: 'a.ts', content: src }],
    );
    expect(unzoned.sites.map((s) => s.token)).toEqual(['alpha', 'beta', 'gamma', 'delta']);
  });

  test('export-names ignores a commented-out export', () => {
    const src = ['export const realThing = 1;', '// export const ghostThing = 2;'].join('\n');
    expect(
      extractTokens({ files: ['**'], extract: 'export-names', scan: 'code' }, [
        { path: 'a.ts', content: src },
      ]).sites.map((s) => s.token),
    ).toEqual(['realThing']);
  });
});

describe('an inapplicable zone is loud', () => {
  test('json-path rejects scan rather than ignoring it', () => {
    const res = extractTokens(
      { files: ['**'], extract: 'json-path', jsonPath: '.a', scan: 'code' },
      [{ path: 'a.json', content: '{"a":1}' }],
    );
    expect(res.error).toContain('does not apply');
    expect(res.sites).toHaveLength(0);
  });

  test('filenames rejects scan — there is no content to zone', () => {
    const res = extractTokens(
      { files: ['**'], extract: 'filenames', scan: 'code' },
      [{ path: 'src/ALPHA_DESCRIPTOR.ts', content: '' }],
    );
    expect(res.error).toContain('does not apply');
  });

  test('an unknown zone names the valid ones', () => {
    const res = extractTokens(
      { files: ['**'], extract: 'export-names', scan: 'kode' as ScanZone },
      [{ path: 'a.ts', content: 'export const x = 1;' }],
    );
    expect(res.error).toContain('unknown `scan` zone');
    expect(res.error).toContain('code-and-templates');
  });
});
