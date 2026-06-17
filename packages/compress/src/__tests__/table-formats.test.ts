import { describe, expect, test } from 'bun:test';
import {
  compactArrayToColumnar,
  expandColumnar,
  columnarToCsv,
  csvToObjects,
  columnarToMarkdownKv,
  markdownKvToObjects,
} from '../index.ts';

const records = [
  { id: 'n1', kind: 'file', score: 0.9, tags: ['a', 'b'], note: 'has, comma and "quote"' },
  { id: 'n2', kind: 'symbol', score: 0.4, tags: [], note: '' },
  { id: 'n3', kind: 'file', score: null, note: 'no tags column here' }, // 'tags' absent
];

describe('read-accuracy table formats (P4.2)', () => {
  test('CSV round-trips the object array losslessly (commas, quotes, null, absent, empty)', () => {
    const table = compactArrayToColumnar(records)!;
    const csv = columnarToCsv(table);
    expect(csv.split('\n')[0]).toContain('id'); // header row of column names
    expect(csvToObjects(csv)).toEqual(expandColumnar(table));
  });

  test('Markdown-KV round-trips the object array losslessly', () => {
    const table = compactArrayToColumnar(records)!;
    const md = columnarToMarkdownKv(table);
    expect(md.startsWith('- ')).toBe(true); // a record opens with `- `
    expect(markdownKvToObjects(md)).toEqual(expandColumnar(table));
  });

  test('CSV and Markdown-KV tolerate CRLF line endings (no \\r contamination)', () => {
    const table = compactArrayToColumnar(records)!;
    const csvCrlf = columnarToCsv(table).replace(/\n/g, '\r\n');
    expect(csvToObjects(csvCrlf)).toEqual(expandColumnar(table));
    const mdCrlf = columnarToMarkdownKv(table).replace(/\n/g, '\r\n');
    expect(markdownKvToObjects(mdCrlf)).toEqual(expandColumnar(table));
  });

  test('both encodings preserve null vs absent distinctly', () => {
    const table = compactArrayToColumnar(records)!;
    const fromCsv = csvToObjects(columnarToCsv(table));
    const fromMd = markdownKvToObjects(columnarToMarkdownKv(table));
    // n3: score is a genuine null (present); tags is absent (missing).
    expect('score' in fromCsv[2]!).toBe(true);
    expect(fromCsv[2]!.score).toBeNull();
    expect('tags' in fromCsv[2]!).toBe(false);
    expect('tags' in fromMd[2]!).toBe(false);
  });
});
