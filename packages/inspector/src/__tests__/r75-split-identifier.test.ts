/**
 * Round 11 — THE identifier tokenizer, and the name matcher built on it.
 *
 * One splitter answers "where is the word boundary in this identifier?" for
 * reuse, spec evidence and the recommender, so two callers can never disagree.
 * The reuse name match is token EQUALITY on that split — never substring, which
 * is how `reuse "ran"` used to match `DateRangePicker` by name.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ReuseNameMatch } from '@shrkcrft/core';
import { splitIdentifierTokens } from '../split-identifier.ts';
import { scoreReuseName } from '../reuse/score-reuse-name.ts';
import { tokenizeReuseIntent } from '../reuse/reuse-tokenize.ts';

describe('splitIdentifierTokens', () => {
  test('PascalCase, an I-prefix and acronym runs', () => {
    expect(splitIdentifierTokens('DateRangePicker')).toEqual(['date', 'range', 'picker']);
    expect(splitIdentifierTokens('IDateRangePickerOptions')).toEqual(['i', 'date', 'range', 'picker', 'options']);
    expect(splitIdentifierTokens('HTTPServer')).toEqual(['http', 'server']);
    expect(splitIdentifierTokens('parseHTTPResponse')).toEqual(['parse', 'http', 'response']);
  });

  test('snake_case, kebab-case, camelCase, whitespace and digits', () => {
    expect(splitIdentifierTokens('date_range_picker')).toEqual(['date', 'range', 'picker']);
    expect(splitIdentifierTokens('date-range-picker')).toEqual(['date', 'range', 'picker']);
    expect(splitIdentifierTokens('formatDateRange')).toEqual(['format', 'date', 'range']);
    expect(splitIdentifierTokens('  date   range picker ')).toEqual(['date', 'range', 'picker']);
    expect(splitIdentifierTokens('parseV2Response')).toEqual(['parse', 'v2', 'response']);
    expect(splitIdentifierTokens('')).toEqual([]);
  });

  test('spec evidence reads the shared splitter instead of carrying its own', () => {
    const src = readFileSync(resolve(import.meta.dir, '../spec/spec-evidence.ts'), 'utf8');
    expect(src).toContain("from '../split-identifier.ts'");
    expect(src).not.toContain('function tokenizeIdentifier');
  });
});

describe('scoreReuseName — token equality on the split name, never substring', () => {
  test("'ran' does not match DateRange by name", () => {
    expect(scoreReuseName('DateRange', ['ran'])).toBe(ReuseNameMatch.None);
  });

  test('exact, covers, partial', () => {
    expect(scoreReuseName('DateRangePicker', tokenizeReuseIntent('date range picker'))).toBe(ReuseNameMatch.Exact);
    // The identifier typed as an intent is the same query as its words.
    expect(scoreReuseName('DateRangePicker', tokenizeReuseIntent('DateRangePicker'))).toBe(ReuseNameMatch.Exact);
    expect(scoreReuseName('DateRangePicker', tokenizeReuseIntent('date picker'))).toBe(ReuseNameMatch.Covers);
    expect(scoreReuseName('DateRangePicker', tokenizeReuseIntent('date slider'))).toBe(ReuseNameMatch.Partial);
    expect(scoreReuseName('AppButton', tokenizeReuseIntent('add a button'))).toBe(ReuseNameMatch.Covers);
  });

  test('both sides go through one normaliser, so a prefix the intent cannot carry does not block exact', () => {
    // `I` is under the minimum token length; `use` is a stop word.
    expect(scoreReuseName('IDateRangePickerOptions', tokenizeReuseIntent('date range picker options'))).toBe(
      ReuseNameMatch.Exact,
    );
    expect(scoreReuseName('useDebounce', tokenizeReuseIntent('debounce'))).toBe(ReuseNameMatch.Exact);
  });

  test('an empty intent matches nothing', () => {
    expect(scoreReuseName('DateRangePicker', [])).toBe(ReuseNameMatch.None);
    expect(scoreReuseName('DateRangePicker', tokenizeReuseIntent('add a new'))).toBe(ReuseNameMatch.None);
  });
});
