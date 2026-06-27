import { describe, expect, test } from 'bun:test';
import { detectContentType, EContentType } from '../index.ts';

/**
 * Labelled detection corpus (P4.4). Each fixture is a (blob → expected class)
 * pair; the suite is the calibration harness for the routing thresholds. New
 * detection rules must keep every prior label green.
 */
const CORPUS: Array<{ name: string; text: string; expect: EContentType }> = [
  // --- the P4.4 fixes ---
  {
    name: 'tsc diagnostics → search (not code)',
    text: 'src/a.ts(10,5): error TS2322: Type mismatch\nsrc/b.ts(3,1): error TS1005: ; expected\nsrc/c.ts(99,12): warning TS6133: unused',
    expect: EContentType.SearchResults,
  },
  {
    name: 'gcc diagnostics → search',
    text: 'main.c:10:5: error: expected ;\nutil.c:3:9: warning: unused var\nmain.c:20:1: note: in expansion',
    expect: EContentType.SearchResults,
  },
  {
    name: 'yaml manifest → yaml (not markdown)',
    text: 'name: my-service\nversion: 1.2.0\ndependencies:\n  - left-pad\n  - lodash\nscripts:\n  build: tsc',
    expect: EContentType.Yaml,
  },
  {
    name: 'list-heavy yaml → yaml (block key + indented seq, not markdown)',
    text: 'dependencies:\n  - left-pad\n  - lodash\n  - zod\n  - react\n  - vue',
    expect: EContentType.Yaml,
  },
  {
    name: 'markdown bullet list with a colon label stays markdown',
    text: '# Changelog\n\nNote: recent changes below\n- added feature a\n- fixed bug b\n- removed c',
    expect: EContentType.Markdown,
  },
  {
    name: 'csv → csv',
    text: 'name,age,city\nalice,30,nyc\nbob,25,sf\ncarol,41,la',
    expect: EContentType.Csv,
  },
  {
    name: 'tsv → csv class',
    text: 'id\tkind\tscore\n1\tfile\t0.9\n2\tsymbol\t0.4\n3\tfile\t0.7',
    expect: EContentType.Csv,
  },
  // --- regression guards for the existing classes ---
  { name: 'json array', text: '[{"a":1},{"a":2}]', expect: EContentType.JsonArray },
  { name: 'json object', text: '{"a":1,"b":2}', expect: EContentType.Json },
  {
    name: 'git diff',
    text: 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-a\n+b',
    expect: EContentType.GitDiff,
  },
  {
    name: 'grep search',
    text: 'src/a.ts:10:hello\nsrc/a.ts:20:world\nsrc/b.ts:1:foo',
    expect: EContentType.SearchResults,
  },
  {
    name: 'build log',
    text: 'INFO starting\nERROR boom\nWARN careful\nFATAL dead\nERROR again',
    expect: EContentType.BuildLog,
  },
  {
    name: 'source code',
    text: 'export function f(x) {\n  this.handler(x);\n  result.value = x;\n  return x;\n}',
    expect: EContentType.SourceCode,
  },
  {
    name: 'markdown doc',
    text: '# Title\n\n- bullet\n- bullet two\n\nsome prose here',
    expect: EContentType.Markdown,
  },
  {
    // Regression: a prose-heavy doc with a SINGLE `# ` header (and no code) used
    // to fall through to PlainText (the old headerCount >= 2 gate) and silently
    // no-op compress. The `!looksLikeScript` + low-codeRatio guards still keep
    // commented scripts out.
    name: 'single-header prose markdown → markdown',
    text:
      '# Release Notes\n\nThe release introduces improvements across the toolkit.\n' +
      'Performance was tuned and startup latency is lower.\n' +
      'The loader reports clearer validation errors now.',
    expect: EContentType.Markdown,
  },
  {
    name: 'ini config stays plain (equals, not colon)',
    text: 'display_errors = On\nerror_reporting = E_ALL\nmemory_limit = 128M',
    expect: EContentType.PlainText,
  },
  {
    name: 'prose stays plain',
    text: 'He went to the market today.\nShe stayed at home.\nThey met for dinner.',
    expect: EContentType.PlainText,
  },
];

describe('detection corpus (P4.4)', () => {
  for (const c of CORPUS) {
    test(c.name, () => {
      expect(detectContentType(c.text)).toBe(c.expect);
    });
  }
});
