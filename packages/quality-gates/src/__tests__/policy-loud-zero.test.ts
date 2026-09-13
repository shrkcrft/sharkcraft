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

  test('loud when a rule is configured but matches no files (evaluated 0): never skipped, never a pass', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-policy-gate-empty-'));
    try {
      // No stylesheets anywhere → the style rule scans nothing. Must NOT read as
      // a green pass — and not as `skipped` either (round 11): the rule was
      // selected and examined nothing, which `shrk gate` must settle like
      // `policy-lint` does. At `error` severity `failOnEmpty` defaults on, so it
      // FAILS, carrying the rule's coverage.
      const r = policyLintGate(root, { rules: [STYLE_RULE] });
      expect(r.status).toBe('fail');
      expect(r.message).toContain('nothing evaluated');
      expect(r.details?.evaluated).toBe(0);
      expect(r.coverage?.[0]).toMatchObject({ subject: 'no-important', expected: 0, examined: 0 });
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
