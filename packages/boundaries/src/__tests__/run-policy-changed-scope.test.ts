import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IPolicyRule } from '@shrkcrft/core';
import { runPolicyLint } from '../policy/run-policy.ts';

// A style rule that flags `!important` debt (the canonical pre-existing-debt case).
const NO_IMPORTANT: IPolicyRule = {
  id: 'no-important',
  surface: 'style',
  pattern: '!important',
  message: 'Avoid !important.',
};

function setup(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-policy-changed-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  // Pre-existing debt in a file the change set never touches.
  writeFileSync(join(root, 'src', 'legacy.css'), '.a { color: red !important; }\n');
  // The file actually changed.
  writeFileSync(join(root, 'src', 'changed.css'), '.b { color: blue !important; }\n');
  return root;
}

describe('runPolicyLint --changed-only restricts the SCANNED files (G1)', () => {
  test('a whole-project scan flags BOTH files (baseline)', () => {
    const root = setup();
    try {
      const r = runPolicyLint(root, [NO_IMPORTANT]);
      expect(r.findings.map((f) => f.file).sort()).toEqual(['src/changed.css', 'src/legacy.css']);
      expect(r.evaluated).toBe(1);
      expect(r.verdict).toBe('errors');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('changed-only flags ONLY the changed file, not pre-existing debt elsewhere', () => {
    const root = setup();
    try {
      const r = runPolicyLint(root, [NO_IMPORTANT], {
        changedOnly: true,
        changedFiles: ['src/changed.css'],
      });
      const files = r.findings.map((f) => f.file);
      expect(files).toEqual(['src/changed.css']);
      expect(files).not.toContain('src/legacy.css'); // untouched debt is out of scope
      expect(r.evaluated).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('changed-only with no changed files in the rule globs reports evaluated 0', () => {
    const root = setup();
    try {
      // The rule IS selected (a .css path is in the change set) but the scanned
      // set is empty because the changed file is not one of the .css files.
      const r = runPolicyLint(root, [NO_IMPORTANT], {
        changedOnly: true,
        changedFiles: ['README.md'],
      });
      // README.md does not match the style globs → rule is filtered out of
      // selection entirely → empty report (evaluated 0).
      expect(r.evaluated).toBe(0);
      expect(r.findings.length).toBe(0);
      expect(r.verdict).toBe('pass');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a rule whose globs match no files reports evaluated 0 (loud-zero signal)', () => {
    const root = setup();
    try {
      // A `ts` rule in a project that has only stylesheets → scans nothing.
      const tsOnly: IPolicyRule = {
        id: 'no-todo',
        surface: 'ts',
        files: ['**/*.ts'],
        pattern: 'TODO',
        message: 'No TODO comments.',
      };
      const r = runPolicyLint(root, [tsOnly]);
      expect(r.evaluated).toBe(0);
      expect(r.findings.length).toBe(0);
      expect(r.verdict).toBe('pass');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
