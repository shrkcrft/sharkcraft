import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IWiringRule } from '@shrkcrft/core';
import { wiringGate } from '../gates/wiring-gate.ts';

const RULE: IWiringRule = {
  id: 'demo.use-must-register',
  declared: { files: ['src/**/*.ts'], pattern: "use\\('([^']+)'\\)" },
  registered: { files: ['registry/**/*.ts'], pattern: "register\\('([^']+)'\\)" },
};

function setup(registerGhost: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-wiring-gate-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'registry'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), "use('alpha')\nuse('ghost')\n");
  writeFileSync(
    join(root, 'registry', 'r.ts'),
    registerGhost ? "register('alpha')\nregister('ghost')\n" : "register('alpha')\n",
  );
  return root;
}

describe('wiringGate', () => {
  test('skipped (never red) when no rules are configured', () => {
    const root = setup(false);
    try {
      const r = wiringGate(root, {});
      expect(r.status).toBe('skipped');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('fails when a declared token is not registered', () => {
    const root = setup(false);
    try {
      const r = wiringGate(root, { rules: [RULE] });
      expect(r.status).toBe('fail');
      expect(r.message).toContain('declared but not wired');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('passes when every declared token is registered', () => {
    const root = setup(true);
    try {
      const r = wiringGate(root, { rules: [RULE] });
      expect(r.status).toBe('pass');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('warning-severity rule warns instead of failing', () => {
    const root = setup(false);
    try {
      const r = wiringGate(root, { rules: [{ ...RULE, severity: 'warning' }] });
      expect(r.status).toBe('warn');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('loud when rules are configured but match no files (evaluated:0): never skipped, never a pass', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-wiring-empty-'));
    try {
      // Round 11: a SELECTED rule that examined nothing is not `skipped` (which
      // `shrk gate` would settle to 0) — at `error` severity `failOnEmpty`
      // defaults on, so it FAILS exactly where `check wiring` exits 1, and it
      // carries the rule's coverage.
      const r = wiringGate(root, { rules: [RULE] });
      expect(r.status).toBe('fail');
      expect(r.message).toContain('nothing evaluated');
      expect(r.details?.evaluated).toBe(0);
      expect(r.coverage?.[0]).toMatchObject({ subject: RULE.id, expected: 0, examined: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('surfaces the evaluated count in details on pass', () => {
    const root = setup(true);
    try {
      const r = wiringGate(root, { rules: [RULE] });
      expect(r.status).toBe('pass');
      expect(r.details?.evaluated).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
