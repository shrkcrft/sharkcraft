/**
 * Round 11 — the repo itself stays import-hygiene clean, checked by the SUITE.
 *
 * During round 11's final gate, `bun test` was fully green while
 * `bun run release:preflight` was red: a new file used a lazy
 * `import('@shrkcrft/mcp-server').then(…)`, which the import-hygiene checker
 * records at ERROR severity, and nothing in the suite ran that checker over the
 * repo (the r37 guard only asserts zero runtime-require findings). A green
 * suite must not hide a red preflight, so this lock runs the same checker
 * `shrk check imports` runs — with the repo's own allowlist — and fails on any
 * non-allowlisted error-severity finding, or on any in-scope file it could not
 * read (an unread file is unexamined, never clean).
 */
import { describe, expect, test } from 'bun:test';
import * as nodePath from 'node:path';
import { buildImportHygieneReport } from '../import-hygiene.ts';

const REPO_ROOT = nodePath.resolve(import.meta.dir, '..', '..', '..', '..');

describe('repo import hygiene', () => {
  test('the engine has zero non-allowlisted error-severity import-hygiene findings', () => {
    const report = buildImportHygieneReport(REPO_ROOT);
    const errors = report.findings
      .filter((f) => f.severity === 'error' && !f.allowlisted)
      .map((f) => `${f.file}:${f.line}  ${f.kind}  ${f.snippet.trim().slice(0, 100)}`);
    expect(errors, `import-hygiene errors (these fail release:preflight):\n  ${errors.join('\n  ')}`).toEqual([]);
    expect(report.verdict).not.toBe('errors');
  });

  test('every in-scope source file was actually read', () => {
    const report = buildImportHygieneReport(REPO_ROOT);
    expect(report.unread ?? []).toEqual([]);
    expect(report.filesInScope ?? 0).toBeGreaterThan(0);
  });
});
