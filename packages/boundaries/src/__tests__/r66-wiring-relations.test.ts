/**
 * Wiring relations + the loud-skip contract.
 *
 * The behaviours under test are the ones that make a gate trustworthy rather
 * than merely present: a rule that checked NOTHING must be distinguishable from
 * a rule that passed, an empty SINK must stay a failure (not become a skip),
 * and every relation must mean exactly what it says.
 */
import { describe, expect, test } from 'bun:test';
import { resolveSourceGlobs, type IWiringRule, type IWiringSource } from '@shrkcrft/core';
import { evaluateWiring, type IWiringFileEntry } from '../wiring/evaluate-wiring.ts';
import { matchesAny } from '../scan/glob.ts';

function resolver(files: readonly IWiringFileEntry[]) {
  return (source: IWiringSource) => files.filter((f) => matchesAny(f.path, resolveSourceGlobs(source)));
}

const SRC = { path: 'src/a.ts', content: 'export const aPlugin = 1;\nexport const bPlugin = 2;\n' };
const REG = { path: 'reg/r.ts', content: 'export const PLUGINS = [aPlugin];\n' };
const REG2 = { path: 'reg2/r.ts', content: 'export const OTHER = [bPlugin];\n' };

const declared: IWiringSource = { files: ['src/**/*.ts'], extract: 'export-names', match: 'Plugin$' };

describe('wiring relations', () => {
  test('subset flags the declared token missing from the union of sinks', () => {
    const rule: IWiringRule = {
      id: 'r',
      declared,
      registered: { files: ['reg/**/*.ts'], extract: 'array-members', anchor: 'PLUGINS' },
    };
    const report = evaluateWiring([rule], resolver([SRC, REG]));
    expect(report.violations.map((v) => v.token)).toEqual(['bPlugin']);
    expect(report.rules[0]!.status).toBe('failed');
  });

  test('union (default) accepts a token registered in ANY sink', () => {
    const rule: IWiringRule = {
      id: 'r',
      declared,
      registered: [
        { files: ['reg/**/*.ts'], extract: 'array-members', anchor: 'PLUGINS' },
        { files: ['reg2/**/*.ts'], extract: 'array-members', anchor: 'OTHER' },
      ],
    };
    expect(evaluateWiring([rule], resolver([SRC, REG, REG2])).violations).toHaveLength(0);
  });

  test('intersection requires the token in EVERY sink — "registered in the wrong one of N"', () => {
    const rule: IWiringRule = {
      id: 'r',
      declared,
      registeredMode: 'intersection',
      registered: [
        { files: ['reg/**/*.ts'], extract: 'array-members', anchor: 'PLUGINS' },
        { files: ['reg2/**/*.ts'], extract: 'array-members', anchor: 'OTHER' },
      ],
    };
    const report = evaluateWiring([rule], resolver([SRC, REG, REG2]));
    expect(report.violations.map((v) => v.token).sort()).toEqual(['aPlugin', 'bPlugin']);
  });

  test('parity also reports a registered token that was never declared', () => {
    const rule: IWiringRule = {
      id: 'r',
      mode: 'parity',
      declared: { files: ['src/**/*.ts'], extract: 'export-names', match: '^aPlugin$' },
      registered: { files: ['reg/**/*.ts'], extract: 'array-members', anchor: 'PLUGINS' },
    };
    const extra = { path: 'reg/r.ts', content: 'export const PLUGINS = [aPlugin, ghostPlugin];\n' };
    const report = evaluateWiring([rule], resolver([SRC, extra]));
    expect(report.violations.map((v) => `${v.direction}:${v.token}`)).toEqual([
      'registered-missing:ghostPlugin',
    ]);
  });

  test('disjoint flags a token present on BOTH sides', () => {
    const rule: IWiringRule = {
      id: 'r',
      mode: 'disjoint',
      declared: { files: ['src/**/*.ts'], extract: 'export-names', match: 'Plugin$' },
      registered: { files: ['reg/**/*.ts'], extract: 'array-members', anchor: 'PLUGINS' },
    };
    const report = evaluateWiring([rule], resolver([SRC, REG]));
    expect(report.violations.map((v) => `${v.direction}:${v.token}`)).toEqual(['overlap:aPlugin']);
  });

  test('a chain evaluates each adjacent hop and names the hop that broke', () => {
    const mid = { path: 'mid/m.ts', content: 'export const MID = [aPlugin, bPlugin];\n' };
    const far = { path: 'far/f.ts', content: 'export const FAR = [aPlugin];\n' };
    const rule: IWiringRule = {
      id: 'r',
      chain: [
        declared,
        { files: ['mid/**/*.ts'], extract: 'array-members', anchor: 'MID' },
        { files: ['far/**/*.ts'], extract: 'array-members', anchor: 'FAR' },
      ],
    };
    const report = evaluateWiring([rule], resolver([SRC, mid, far]));
    expect(report.violations.map((v) => `hop${v.hop}:${v.token}`)).toEqual(['hop1:bPlugin']);
    expect(report.rules[0]!.hops).toEqual([
      { index: 0, fromCount: 2, toCount: 2, missing: 0 },
      { index: 1, fromCount: 2, toCount: 1, missing: 1 },
    ]);
  });

  test('a `message` template is rendered per violation', () => {
    const rule: IWiringRule = {
      id: 'r',
      declared,
      registered: { files: ['reg/**/*.ts'], extract: 'array-members', anchor: 'PLUGINS' },
      message: '{id} is declared in {file} but never registered',
    };
    const report = evaluateWiring([rule], resolver([SRC, REG]));
    expect(report.violations[0]!.message).toBe('bPlugin is declared in src/a.ts but never registered');
  });
});

describe('wiring — the loud-skip contract', () => {
  test('a source that matches 0 files is SKIPPED, never a pass', () => {
    // `warning` severity keeps the historical default (failOnEmpty off), so
    // this isolates the SKIP itself from the fail-on-empty promotion.
    const rule: IWiringRule = {
      id: 'r',
      severity: 'warning',
      declared: { files: ['nowhere/**/*.ts'], extract: 'export-names' },
      registered: { files: ['reg/**/*.ts'], extract: 'array-members', anchor: 'PLUGINS' },
    };
    const report = evaluateWiring([rule], resolver([REG]));
    expect(report.rules[0]!.status).toBe('skipped');
    expect(report.evaluated).toBe(0);
    expect(report.skipped[0]!.reason).toContain('0 files');
    expect(report.skipped[0]!.failed).toBe(false);
  });

  test('an ERROR-severity rule fails on empty by default (alpha.29)', () => {
    // The default flipped: an error rule exists to block a build, so one that
    // matches zero subjects is a bug in the rule, not a pass.
    const rule: IWiringRule = {
      id: 'r',
      declared: { files: ['nowhere/**/*.ts'], extract: 'export-names' },
      registered: { files: ['reg/**/*.ts'], extract: 'array-members', anchor: 'PLUGINS' },
    };
    const report = evaluateWiring([rule], resolver([REG]));
    expect(report.rules[0]!.status).toBe('failed');
    expect(report.skipped[0]!.failed).toBe(true);
    expect(report.verdict).toBe('errors');
  });

  test('an explicit failOnEmpty:false opts back out', () => {
    const rule: IWiringRule = {
      id: 'r',
      failOnEmpty: false,
      declared: { files: ['nowhere/**/*.ts'], extract: 'export-names' },
      registered: { files: ['reg/**/*.ts'], extract: 'array-members', anchor: 'PLUGINS' },
    };
    const report = evaluateWiring([rule], resolver([REG]));
    expect(report.rules[0]!.status).toBe('skipped');
    expect(report.verdict).toBe('pass');
  });

  test('a source that matches files but extracts 0 ids is also a skip', () => {
    const rule: IWiringRule = {
      id: 'r',
      declared: { files: ['src/**/*.ts'], extract: 'export-names', match: 'NoSuchSuffix$' },
      registered: { files: ['reg/**/*.ts'], extract: 'array-members', anchor: 'PLUGINS' },
    };
    const report = evaluateWiring([rule], resolver([SRC, REG]));
    expect(report.skipped[0]!.reason).toContain('0 ids');
  });

  test('failOnEmpty promotes the skip to a failure the verdict can see', () => {
    const rule: IWiringRule = {
      id: 'r',
      failOnEmpty: true,
      declared: { files: ['nowhere/**/*.ts'], extract: 'export-names' },
      registered: { files: ['reg/**/*.ts'], extract: 'array-members', anchor: 'PLUGINS' },
    };
    const report = evaluateWiring([rule], resolver([REG]));
    expect(report.rules[0]!.status).toBe('failed');
    expect(report.skipped[0]!.failed).toBe(true);
    expect(report.verdict).toBe('errors');
  });

  test('an empty SINK stays a FAILURE (annotated), never downgraded to a skip', () => {
    const rule: IWiringRule = {
      id: 'r',
      declared,
      registered: { files: ['reg/**/*.ts'], extract: 'array-members', anchor: 'NO_SUCH_ARRAY' },
    };
    const report = evaluateWiring([rule], resolver([SRC, REG]));
    expect(report.rules[0]!.status).toBe('failed');
    expect(report.rules[0]!.emptySink).toBe(true);
    expect(report.violations).toHaveLength(2);
  });

  test('a structurally invalid rule degrades to a diagnostic, never a throw', () => {
    const rule = { id: 'bad', chain: [declared] } as unknown as IWiringRule;
    const report = evaluateWiring([rule], resolver([SRC]));
    expect(report.diagnostics[0]).toContain('at least 2 hops');
    expect(report.verdict).toBe('errors');
  });
});
