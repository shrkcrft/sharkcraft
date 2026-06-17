import { describe, expect, test } from 'bun:test';
import { mineLogTemplates, reconstructLogTemplates } from './packages/compress/src/text/log-template.ts';

const CURRENT_VAR_RE = new RegExp(
  [
    '\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?',
    '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}',
    '0x[0-9a-fA-F]+',
    '\b[0-9a-fA-F]{12,}\b',
    '"(?:[^"\\]|\\.)*"',
    "'(?:[^'\\]|\\.)*'",
    '\d+(?:\.\d+)?',
  ].join('|'),
  'g',
);

const PROPOSED_VAR_RE = new RegExp(
  [
    '\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?',
    '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}',
    '0x[0-9a-fA-F]+',
    '\b[0-9a-fA-F]{12,}\b',
    '"""(?:[^"]|"(?!""))*"""',  // PROPOSED: triple double
    "'''(?:[^']|'(?!''))*'''",   // PROPOSED: triple single
    '"(?:[^"\\]|\\.)*"',
    "'(?:[^'\\]|\\.)*'",
    '\d+(?:\.\d+)?',
  ].join('|'),
  'g',
);

describe('Triple-quote proposal: order+count invariant check', () => {
  test('current regex: Python traceback strings stay as literals (not captured)', () => {
    const traceback = 'python.c:1234: Fatal Python error: """detail"""';
    const matches = traceback.match(CURRENT_VAR_RE) || [];
    expect(matches).not.toContain('"""detail"""');
    expect(matches).toEqual(['1234']); // only the number is captured
  });

  test('proposed regex WOULD capture triple quotes', () => {
    const traceback = 'python.c:1234: Fatal Python error: """detail"""';
    const matches = traceback.match(PROPOSED_VAR_RE) || [];
    expect(matches).toContain('"""detail"""');
    expect(matches.length).toBeGreaterThan(1);
  });

  test('CRITICAL: match count variance breaks column extraction', () => {
    // If two lines in a run have different match counts, encodeBlock's
    // v[c] indexing will silently misalign columns.
    const line1 = 'process """multi-line log""" exit 0';
    const line2 = 'process "simple" exit 1';
    
    const matches1 = line1.match(PROPOSED_VAR_RE) || [];
    const matches2 = line2.match(PROPOSED_VAR_RE) || [];
    
    console.log(`Line1: ${line1}`);
    console.log(`  Matches: [${matches1.join(', ')}] (count=${matches1.length})`);
    console.log(`Line2: ${line2}`);
    console.log(`  Matches: [${matches2.join(', ')}] (count=${matches2.length})`);
    
    // If counts differ, extracting v[1] gives different semantics per line!
    const canAlign = matches1.length === matches2.length;
    console.log(`\nCan align safely: ${canAlign}`);
    
    if (!canAlign) {
      console.log('ERROR: This breaks the invariant!');
      console.log(`  line1[1] = "${matches1[1]}" (should exist)`);
      console.log(`  line2[1] = "${matches2[1]}" (different type!)`);
    }
  });

  test('proposed regex breaks round-trip on mixed logs', () => {
    // Demonstrate that adding triple quotes changes template shape differently
    // across similar-looking lines, breaking the mining assumption.
    const lines = [
      'info """block 1""" ok',
      'info """block 2""" ok',
      'info "string" ok',      // same template? NO!
    ];
    
    // All three SHOULD have the same template if they're being collapsed together.
    const template1 = lines[0].replace(PROPOSED_VAR_RE, '{}');
    const template2 = lines[1].replace(PROPOSED_VAR_RE, '{}');
    const template3 = lines[2].replace(PROPOSED_VAR_RE, '{}');
    
    console.log(`Template 1: "${template1}"`);
    console.log(`Template 2: "${template2}"`);
    console.log(`Template 3: "${template3}"`);
    
    // They SHOULD all be identical if grouped together.
    // But with the proposed regex, they might not be!
    const allSame = template1 === template2 && template2 === template3;
    if (!allSame) {
      console.log('ALERT: Templates differ - mining would not group these together');
    }
  });
});
