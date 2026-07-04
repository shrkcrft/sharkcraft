import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildImportHygieneReport } from '../import-hygiene.ts';

/**
 * Import-hygiene must gate test/fixture files IDENTICALLY whether the file set is
 * discovered (whole-tree scan) or passed explicitly (changed-only / `finish`).
 * Before the a27 fix the explicit `files` path skipped the `__tests__` exclusion,
 * so a changed test whose fixture STRINGS contain import-like text (`"require('x')"`)
 * spuriously failed `finish`'s imports gate while `check imports` passed.
 */
function fixture(): { root: string; testFile: string; srcFile: string } {
  const root = mkdtempSync(join(tmpdir(), 'shrk-hygiene-excl-'));
  const testDir = join(root, 'packages', 'x', 'src', '__tests__');
  const srcDir = join(root, 'packages', 'x', 'src');
  mkdirSync(testDir, { recursive: true });
  // A test file whose fixture STRINGS contain import-like text — not real code.
  writeFileSync(
    join(testDir, 'scan.test.ts'),
    "const sample = \"const cjs = require('./required');\";\nconst lazy = \"() => import('./dynamic')\";\nvoid sample; void lazy;\n",
  );
  // A genuine source file with a real runtime require — MUST still be flagged.
  writeFileSync(
    join(srcDir, 'real.ts'),
    "export function load() { const fs = require('node:fs'); return fs; }\n",
  );
  return {
    root,
    testFile: 'packages/x/src/__tests__/scan.test.ts',
    srcFile: 'packages/x/src/real.ts',
  };
}

describe('import-hygiene test/fixture exclusion (explicit files path)', () => {
  test('a __tests__ file passed EXPLICITLY is excluded (parity with the whole-tree scan)', () => {
    const { root, testFile } = fixture();
    try {
      const report = buildImportHygieneReport(root, { files: [testFile] });
      expect(report.findings).toEqual([]);
      expect(report.verdict).toBe('ok');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a genuine source file passed explicitly is STILL gated (no over-exclusion)', () => {
    const { root, srcFile } = fixture();
    try {
      const report = buildImportHygieneReport(root, { files: [srcFile] });
      expect(report.findings.length).toBeGreaterThan(0);
      expect(report.findings.some((f) => f.file.includes('real.ts'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
