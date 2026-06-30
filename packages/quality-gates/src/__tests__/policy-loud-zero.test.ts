import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IPolicyRule } from '@shrkcrft/core';
import { policyLintGate } from '../gates/policy-lint-gate.ts';

const STYLE_RULE: IPolicyRule = {
  id: 'no-important',
  surface: 'style',
  pattern: '!important',
  message: 'Avoid !important.',
};

describe('policyLintGate loud-zero (G2)', () => {
  test('skipped (never red) when no rules are configured', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-policy-gate-norules-'));
    try {
      const r = policyLintGate(root, {});
      expect(r.status).toBe('skipped');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('skipped (loud) when a rule is configured but matches no files (evaluated 0)', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-policy-gate-empty-'));
    try {
      // No stylesheets anywhere → the style rule scans nothing. Must NOT read as
      // a green pass: evaluating zero files is `skipped`, surfaced loudly.
      const r = policyLintGate(root, { rules: [STYLE_RULE] });
      expect(r.status).toBe('skipped');
      expect(r.message).toContain('nothing evaluated');
      expect(r.details?.evaluated).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('pass on a real clean scan (rule evaluated ≥1 file, no violations)', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-policy-gate-clean-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'ok.css'), '.a { color: red; }\n');
      const r = policyLintGate(root, { rules: [STYLE_RULE] });
      expect(r.status).toBe('pass');
      expect(r.details?.evaluated).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('fail on a real violation (distinct from the loud-zero skip)', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-policy-gate-fail-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'bad.css'), '.a { color: red !important; }\n');
      const r = policyLintGate(root, { rules: [STYLE_RULE] });
      expect(r.status).toBe('fail');
      expect(r.details?.evaluated).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
