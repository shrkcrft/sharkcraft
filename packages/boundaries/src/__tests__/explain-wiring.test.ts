import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IWiringRule } from '@shrkcrft/core';
import { WIRING_EXPLAIN_SCHEMA, explainWiring } from '../wiring/explain-wiring.ts';

const RULE: IWiringRule = {
  id: 'demo.use-must-register',
  description: 'Every used token must be registered.',
  declared: { files: ['src/**/*.ts'], pattern: "use\\('([^']+)'\\)" },
  registered: { files: ['registry/**/*.ts'], pattern: "register\\('([^']+)'\\)" },
  hint: 'Add a register() call.',
};

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-explain-wiring-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'registry'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), "use('alpha')\nuse('beta')\n");
  writeFileSync(join(root, 'registry', 'r.ts'), "register('alpha')\n");
  return root;
}

describe('explainWiring', () => {
  test('surfaces the full declared + registered sets with file:line', () => {
    const root = fixture();
    try {
      const report = explainWiring(root, RULE);
      expect(report.schema).toBe(WIRING_EXPLAIN_SCHEMA);
      expect(report.ruleId).toBe('demo.use-must-register');
      expect(report.mode).toBe('subset');

      // Declared side: alpha@line1, beta@line2.
      expect(report.declared.distinctCount).toBe(2);
      expect(report.declared.sites.map((s) => s.token).sort()).toEqual(['alpha', 'beta']);
      const beta = report.declared.sites.find((s) => s.token === 'beta');
      expect(beta).toEqual({ token: 'beta', file: 'src/a.ts', line: 2 });

      // Registered side: only alpha.
      expect(report.registered.distinctCount).toBe(1);
      expect(report.registered.sites.map((s) => s.token)).toEqual(['alpha']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('reports the set-difference (declared but NOT registered) + verdict', () => {
    const root = fixture();
    try {
      const report = explainWiring(root, RULE);
      expect(report.declaredNotRegistered.map((s) => s.token)).toEqual(['beta']);
      expect(report.declaredNotRegistered[0]).toEqual({ token: 'beta', file: 'src/a.ts', line: 2 });
      expect(report.registeredNotDeclared).toEqual([]);
      expect(report.verdict).toBe('errors');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('parity mode also reports registered-but-not-declared tokens', () => {
    const root = fixture();
    try {
      // alpha is both; beta is declared-only; (nothing registered-only here, so
      // add one) — register an extra token that is never declared.
      writeFileSync(join(root, 'registry', 'r.ts'), "register('alpha')\nregister('ghost')\n");
      const report = explainWiring(root, { ...RULE, mode: 'parity' });
      expect(report.declaredNotRegistered.map((s) => s.token)).toEqual(['beta']);
      expect(report.registeredNotDeclared.map((s) => s.token)).toEqual(['ghost']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a misconfigured candidate degrades to a diagnostic, never throws', () => {
    const root = fixture();
    try {
      // Pattern with no capture group → engine emits a diagnostic, no crash.
      const report = explainWiring(root, {
        ...RULE,
        declared: { files: ['src/**/*.ts'], pattern: "use\\('[^']+'\\)" },
      });
      expect(report.diagnostics.length).toBeGreaterThan(0);
      expect(report.diagnostics.join(' ')).toContain('capture group');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
