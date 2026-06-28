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
});
