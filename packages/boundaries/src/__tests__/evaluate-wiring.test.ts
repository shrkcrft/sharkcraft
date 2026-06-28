import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IWiringRule } from '@shrkcrft/core';
import { evaluateWiring, type IWiringFileEntry } from '../wiring/evaluate-wiring.ts';
import { runWiring } from '../wiring/scan-wiring-files.ts';

// A generic rule: every token DECLARED via `use('X')` must be REGISTERED via
// `register('X')` somewhere. No language/framework specifics.
const RULE: IWiringRule = {
  id: 'demo.use-must-register',
  description: 'Every used token must be registered.',
  declared: { files: ['src/**/*.ts'], pattern: "use\\('([^']+)'\\)" },
  registered: { files: ['registry/**/*.ts'], pattern: "register\\('([^']+)'\\)" },
  hint: 'Add a register() call.',
};

describe('evaluateWiring (pure)', () => {
  const resolver = (entries: IWiringFileEntry[]) => (source: { files: readonly string[] }) =>
    entries.filter((e) => source.files.some((g) => e.path.startsWith(g.replace(/\/\*\*.*$/, '/'))));

  test('flags declared tokens absent from the registered set', () => {
    const files: IWiringFileEntry[] = [
      { path: 'src/a.ts', content: "use('alpha')\nuse('beta')\n" },
      { path: 'registry/r.ts', content: "register('alpha')\n" },
    ];
    const report = evaluateWiring([RULE], resolver(files));
    expect(report.verdict).toBe('errors');
    expect(report.violations.map((v) => v.token)).toEqual(['beta']);
    expect(report.violations[0]!.file).toBe('src/a.ts');
    expect(report.violations[0]!.line).toBe(2);
    expect(report.violations[0]!.hint).toBe('Add a register() call.');
    expect(report.rules[0]!.declaredCount).toBe(2);
    expect(report.rules[0]!.registeredCount).toBe(1);
  });

  test('passes when every declared token is registered', () => {
    const files: IWiringFileEntry[] = [
      { path: 'src/a.ts', content: "use('alpha')\n" },
      { path: 'registry/r.ts', content: "register('alpha')\nregister('beta')\n" },
    ];
    const report = evaluateWiring([RULE], resolver(files));
    expect(report.verdict).toBe('pass');
    expect(report.violations).toEqual([]);
  });

  test('severity warning does not produce an error verdict', () => {
    const files: IWiringFileEntry[] = [{ path: 'src/a.ts', content: "use('x')\n" }];
    const report = evaluateWiring([{ ...RULE, severity: 'warning' }], resolver(files));
    expect(report.verdict).toBe('warnings');
    expect(report.violations[0]!.severity).toBe('warning');
  });

  test('an uncompilable pattern degrades to a diagnostic, never throws', () => {
    const bad: IWiringRule = { ...RULE, id: 'bad', declared: { files: ['src/**/*.ts'], pattern: '([A-Z' } };
    const files: IWiringFileEntry[] = [{ path: 'src/a.ts', content: 'X\n' }];
    let report!: ReturnType<typeof evaluateWiring>;
    expect(() => {
      report = evaluateWiring([bad], resolver(files));
    }).not.toThrow();
    expect(report.verdict).toBe('errors');
    expect(report.diagnostics.length).toBe(1);
    expect(report.diagnostics[0]).toContain('invalid regex');
    expect(report.rules[0]!.error).toBeDefined();
  });

  test('bad regex flags degrade to a diagnostic', () => {
    const bad: IWiringRule = {
      ...RULE,
      id: 'badflags',
      declared: { files: ['src/**/*.ts'], pattern: "use\\('([^']+)'\\)", flags: 'x' },
    };
    const report = evaluateWiring([bad], resolver([{ path: 'src/a.ts', content: "use('x')\n" }]));
    expect(report.verdict).toBe('errors');
    expect(report.diagnostics[0]).toContain('invalid regex');
  });

  test('a pattern with no capture group is a diagnostic, not a silent pass', () => {
    const noGroup: IWiringRule = {
      ...RULE,
      id: 'nogroup',
      declared: { files: ['src/**/*.ts'], pattern: 'use' },
    };
    const report = evaluateWiring([noGroup], resolver([{ path: 'src/a.ts', content: 'use\n' }]));
    expect(report.verdict).toBe('errors');
    expect(report.diagnostics[0]).toContain('no capture group');
  });
});

describe('runWiring (fs-backed)', () => {
  function setup(): string {
    const root = mkdtempSync(join(tmpdir(), 'shrk-wiring-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'registry'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), "use('alpha')\nuse('ghost')\n");
    writeFileSync(join(root, 'registry', 'r.ts'), "register('alpha')\n");
    return root;
  }

  test('walks the tree and reports the unregistered token', () => {
    const root = setup();
    try {
      const report = runWiring(root, [RULE]);
      expect(report.violations.map((v) => v.token)).toEqual(['ghost']);
      expect(report.violations[0]!.file).toBe('src/a.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('--changed-only skips rules untouched by the change set', () => {
    const root = setup();
    try {
      // A changed file outside the rule's globs → rule is skipped → pass.
      const skipped = runWiring(root, [RULE], { changedOnly: true, changedFiles: ['docs/x.md'] });
      expect(skipped.rules).toEqual([]);
      expect(skipped.verdict).toBe('pass');
      // A changed file inside the rule's declared globs → rule runs → violation.
      const run = runWiring(root, [RULE], { changedOnly: true, changedFiles: ['src/a.ts'] });
      expect(run.violations.map((v) => v.token)).toEqual(['ghost']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('--only filters to the named rule', () => {
    const root = setup();
    try {
      const report = runWiring(root, [RULE], { only: ['nonexistent'] });
      expect(report.rules).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
