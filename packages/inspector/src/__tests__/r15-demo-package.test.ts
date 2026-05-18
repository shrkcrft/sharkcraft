import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { DemoScenario, buildDemoPackage } from '../index.ts';

describe('r15 demo package', () => {
  test('emits expected files for "all" scope', () => {
    const dir = mkdtempSync(nodePath.join(tmpdir(), 'sharkcraft-r15-pkg-all-'));
    const result = buildDemoPackage({ outputDir: dir, scope: 'all' });
    const names = result.files.map((f) => nodePath.basename(f.path));
    expect(names).toContain('README.md');
    expect(names).toContain('demo.sh');
    expect(names).toContain('expected-commands.md');
    expect(names).toContain('sample-output-notes.md');
    for (const s of result.scenarios) {
      expect(names).toContain(`scenario-${s}.sh`);
    }
  });

  test('emits a single scenario when requested', () => {
    const dir = mkdtempSync(nodePath.join(tmpdir(), 'sharkcraft-r15-pkg-one-'));
    const result = buildDemoPackage({ outputDir: dir, scope: DemoScenario.PrReview });
    expect(result.scenarios).toEqual([DemoScenario.PrReview]);
    const names = result.files.map((f) => nodePath.basename(f.path));
    expect(names).toContain('scenario-pr-review.sh');
    expect(names).not.toContain('scenario-governance.sh');
  });

  test('demo.sh never contains destructive commands', () => {
    const dir = mkdtempSync(nodePath.join(tmpdir(), 'sharkcraft-r15-pkg-safe-'));
    const result = buildDemoPackage({ outputDir: dir, scope: 'all' });
    const demoShell = result.files.find((f) => f.path.endsWith('demo.sh'))!;
    const body = readFileSync(demoShell.path, 'utf8');
    expect(/\brm\s+-rf\b/.test(body)).toBe(false);
    expect(body).toContain('set -euo pipefail');
  });
});
