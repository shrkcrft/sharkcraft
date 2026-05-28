import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDotenv } from '../env/load-dotenv.ts';

const KEYS = [
  'SHARKCRAFT_TEST_KEY_1',
  'SHARKCRAFT_TEST_KEY_2',
  'SHARKCRAFT_TEST_KEY_3',
  'SHARKCRAFT_TEST_QUOTED',
  'SHARKCRAFT_TEST_INLINE_COMMENT',
];

let tempDir = '';

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'shrk-dotenv-'));
  for (const k of KEYS) delete process.env[k];
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  for (const k of KEYS) delete process.env[k];
});

describe('loadDotenv', () => {
  test('loads KEY=VALUE pairs from .env into process.env', () => {
    writeFileSync(
      join(tempDir, '.env'),
      [
        'SHARKCRAFT_TEST_KEY_1=alpha',
        'SHARKCRAFT_TEST_KEY_2=beta',
        '',
        '# a comment',
        '   ',
      ].join('\n'),
      'utf8',
    );
    loadDotenv(tempDir);
    expect(process.env.SHARKCRAFT_TEST_KEY_1).toBe('alpha');
    expect(process.env.SHARKCRAFT_TEST_KEY_2).toBe('beta');
  });

  test('never overwrites an already-set env var', () => {
    process.env.SHARKCRAFT_TEST_KEY_1 = 'shell-value';
    writeFileSync(join(tempDir, '.env'), 'SHARKCRAFT_TEST_KEY_1=file-value\n', 'utf8');
    loadDotenv(tempDir);
    expect(process.env.SHARKCRAFT_TEST_KEY_1).toBe('shell-value');
  });

  test('strips surrounding quotes and decodes \\n inside double-quoted values', () => {
    writeFileSync(
      join(tempDir, '.env'),
      [
        'SHARKCRAFT_TEST_QUOTED="line1\\nline2"',
        "SHARKCRAFT_TEST_KEY_3='no-escapes\\nstays'",
      ].join('\n'),
      'utf8',
    );
    loadDotenv(tempDir);
    expect(process.env.SHARKCRAFT_TEST_QUOTED).toBe('line1\nline2');
    expect(process.env.SHARKCRAFT_TEST_KEY_3).toBe('no-escapes\\nstays');
  });

  test('strips inline " # comment" tails on unquoted values', () => {
    writeFileSync(
      join(tempDir, '.env'),
      'SHARKCRAFT_TEST_INLINE_COMMENT=value # trailing\n',
      'utf8',
    );
    loadDotenv(tempDir);
    expect(process.env.SHARKCRAFT_TEST_INLINE_COMMENT).toBe('value');
  });

  test('is a no-op when no .env exists up the tree', () => {
    const isolated = mkdtempSync(join(tmpdir(), 'shrk-dotenv-isolated-'));
    try {
      // Pre-condition: keys must be unset before we call loader.
      delete process.env.SHARKCRAFT_TEST_KEY_1;
      loadDotenv(isolated);
      // Loader walks up the tree, but the temp dir is under tmpdir() and
      // none of its ancestors should contain a key we control. The
      // assertion we care about is that nothing was *invented*.
      expect(process.env.SHARKCRAFT_TEST_KEY_1).toBeUndefined();
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });
});
