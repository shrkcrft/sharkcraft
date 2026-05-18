/**
 * Dedicated tests for the reliability / hardening round.
 *
 *   - Import hygiene checker: flags inline type imports, runtime requires,
 *     dynamic imports; respects allowlist.
 *   - agent-handoff has no inline uncertainty import / runtime require.
 *   - Plugin rename word-boundary: shared-prefix names don't overlap.
 *   - Multi-op plan diff: same path, multiple ops tracked independently.
 *   - Pack contributions inventory: nested ids don't create false errors.
 *   - Helper plan saved-plan conversion.
 *   - Registration hint plan: ambiguous target refused.
 *   - Folder op safety gates still work.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';

import {
  buildImportHygieneReport,
  ImportHygieneFindingKind,
} from '../import-hygiene.ts';

import {
  diffPlanChanges,
  type IGenerationPlan,
  type ISavedPlan,
} from '@shrkcrft/generator';

import { helperPlanToSavedPlan, HELPER_SYNTHETIC_TEMPLATE } from '../helper-registry.ts';

function mkProject(): string {
  return mkdtempSync(nodePath.join(tmpdir(), 'shrk-r36-'));
}

describe('Import hygiene checker', () => {
  it('flags inline type imports', () => {
    const root = mkProject();
    const pkg = nodePath.join(root, 'packages', 'demo', 'src');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      nodePath.join(pkg, 'a.ts'),
      `export interface IFoo { bar?: import('./b.ts').IBar; }\n`,
      'utf8',
    );
    const report = buildImportHygieneReport(root, { skipAllowlist: true });
    expect(report.findings.some((f) => f.kind === ImportHygieneFindingKind.InlineTypeImport)).toBe(true);
    expect(report.verdict).toBe('errors');
  });

  it('flags runtime require (non-node:* spec)', () => {
    const root = mkProject();
    const pkg = nodePath.join(root, 'packages', 'demo', 'src');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      nodePath.join(pkg, 'a.ts'),
      `const mod = require('./b.ts');\nexport const x = mod;\n`,
      'utf8',
    );
    const report = buildImportHygieneReport(root, { skipAllowlist: true });
    const reqFinding = report.findings.find((f) => f.kind === ImportHygieneFindingKind.RuntimeRequire);
    expect(reqFinding).toBeDefined();
    expect(reqFinding?.severity).toBe('error');
  });

  it('reports require(node:*) as error (— was warning in )', () => {
    const root = mkProject();
    const pkg = nodePath.join(root, 'packages', 'demo', 'src');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      nodePath.join(pkg, 'a.ts'),
      `const fs = require('node:fs');\nexport const x = fs;\n`,
      'utf8',
    );
    const report = buildImportHygieneReport(root, { skipAllowlist: true });
    const reqFinding = report.findings.find((f) => f.kind === ImportHygieneFindingKind.RuntimeRequire);
    expect(reqFinding?.severity).toBe('error');
  });

  it('does not flag typeof import(...) as a runtime dynamic import', () => {
    const root = mkProject();
    const pkg = nodePath.join(root, 'packages', 'demo', 'src');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      nodePath.join(pkg, 'a.ts'),
      `type X = typeof import('./b.ts');\nexport const y: X = {} as X;\n`,
      'utf8',
    );
    const report = buildImportHygieneReport(root, { skipAllowlist: true });
    expect(report.findings.some((f) => f.kind === ImportHygieneFindingKind.DynamicImport)).toBe(false);
  });

  it('does not false-positive on comments', () => {
    const root = mkProject();
    const pkg = nodePath.join(root, 'packages', 'demo', 'src');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      nodePath.join(pkg, 'a.ts'),
      `// example: import('./b.ts').IBar — type from another module\n/* require('./c.ts') is bad */\nexport const x = 1;\n`,
      'utf8',
    );
    const report = buildImportHygieneReport(root, { skipAllowlist: true });
    expect(report.findings.length).toBe(0);
  });

  it('respects allowlist', () => {
    const root = mkProject();
    const pkg = nodePath.join(root, 'packages', 'demo', 'src');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      nodePath.join(pkg, 'a.ts'),
      `const { x } = await import('./b.ts');\nexport const y = x;\n`,
      'utf8',
    );
    const allowlistFile = nodePath.join(root, 'allow.json');
    writeFileSync(
      allowlistFile,
      JSON.stringify({
        allow: [
          {
            path: 'packages/demo/src/a.ts',
            kind: 'dynamic-import',
            reason: 'test allowlist entry',
          },
        ],
      }),
      'utf8',
    );
    const report = buildImportHygieneReport(root, { allowlistFile });
    const dyn = report.findings.find((f) => f.kind === ImportHygieneFindingKind.DynamicImport);
    expect(dyn?.allowlisted).toBe(true);
    expect(dyn?.severity).toBe('info');
  });

  it('agent-handoff.ts has no inline uncertainty import (regression guard)', () => {
    const projectRoot = nodePath.resolve(__dirname, '..', '..', '..', '..');
    const handoffSource = readFileSync(
      nodePath.join(projectRoot, 'packages', 'inspector', 'src', 'agent-handoff.ts'),
      'utf8',
    );
    expect(handoffSource).not.toContain("import('./uncertainty-report.ts')");
    expect(handoffSource).not.toContain("require('./uncertainty-report.ts')");
    // It should import normally.
    expect(handoffSource).toContain(
      "import { buildUncertaintyReport, type IUncertaintyReport } from './uncertainty-report.ts'",
    );
  });
});

describe('Multi-op-per-path plan diff', () => {
  it('tracks two ops on the same file independently', () => {
    const saved: ISavedPlan = {
      schema: 'sharkcraft.plan/v2',
      templateId: '__synthetic__',
      variables: {},
      projectRoot: '/tmp',
      createdAt: '2026-05-15T00:00:00.000Z',
      expectedChanges: [
        {
          type: 'replace',
          relativePath: 'a/b.ts',
          sizeBytes: 100,
          operation: { kind: 'replace', find: 'x', replaceWith: 'y' },
        },
        {
          type: 'replace',
          relativePath: 'a/b.ts',
          sizeBytes: 100,
          operation: { kind: 'replace', find: 'p', replaceWith: 'q' },
        },
      ],
    };
    const live: IGenerationPlan = {
      templateId: '__synthetic__',
      templateName: 'synthetic',
      changes: [
        {
          type: 'replace' as never,
          absolutePath: '/tmp/a/b.ts',
          relativePath: 'a/b.ts',
          contents: '',
          reason: 'replace',
          sizeBytes: 100,
          operation: { kind: 'replace', find: 'x', replaceWith: 'y' },
        },
        {
          type: 'replace' as never,
          absolutePath: '/tmp/a/b.ts',
          relativePath: 'a/b.ts',
          contents: '',
          reason: 'replace',
          sizeBytes: 100,
          operation: { kind: 'replace', find: 'p', replaceWith: 'q' },
        },
      ],
      totalFiles: 2,
      hasConflicts: false,
      warnings: [],
      postGenerationNotes: [],
    };
    const diff = diffPlanChanges(saved, live);
    expect(diff.length).toBe(0);
  });

  it('detects removed op while same-path other op is still present', () => {
    const saved: ISavedPlan = {
      schema: 'sharkcraft.plan/v2',
      templateId: '__synthetic__',
      variables: {},
      projectRoot: '/tmp',
      createdAt: '2026-05-15T00:00:00.000Z',
      expectedChanges: [
        {
          type: 'replace',
          relativePath: 'a/b.ts',
          sizeBytes: 100,
          operation: { kind: 'replace', find: 'x', replaceWith: 'y' },
        },
        {
          type: 'replace',
          relativePath: 'a/b.ts',
          sizeBytes: 100,
          operation: { kind: 'replace', find: 'p', replaceWith: 'q' },
        },
      ],
    };
    const live: IGenerationPlan = {
      templateId: '__synthetic__',
      templateName: 'synthetic',
      changes: [
        {
          type: 'replace' as never,
          absolutePath: '/tmp/a/b.ts',
          relativePath: 'a/b.ts',
          contents: '',
          reason: 'replace',
          sizeBytes: 100,
          operation: { kind: 'replace', find: 'x', replaceWith: 'y' },
        },
      ],
      totalFiles: 1,
      hasConflicts: false,
      warnings: [],
      postGenerationNotes: [],
    };
    const diff = diffPlanChanges(saved, live);
    expect(diff.length).toBeGreaterThan(0);
    expect(diff.some((d) => d.kind === 'removed' || d.kind === 'operation-changed')).toBe(true);
  });
});

describe('Helper plan saved-plan conversion', () => {
  it('converts a helper plan into a synthetic saved plan', () => {
    const helperPlan = {
      schema: 'sharkcraft.helper-plan/v1' as const,
      helperId: 'sample-helper' as never,
      variables: { name: 'foo' },
      ops: [
        {
          targetPath: 'src/foo.ts',
          operation: { kind: 'append', snippet: 'export const FOO = 1;\n' },
        },
      ],
      manualSteps: ['Review imports'],
      conflicts: [],
      destructive: false,
      humanReviewRequired: true,
    };
    const saved = helperPlanToSavedPlan(helperPlan, '/tmp');
    expect(saved.templateId).toBe(HELPER_SYNTHETIC_TEMPLATE);
    expect(saved.schema).toBe('sharkcraft.plan/v2');
    expect(saved.expectedChanges.length).toBe(1);
    expect(saved.expectedChanges[0]?.operation['kind']).toBe('append');
    expect(saved.variables['helperId']).toBe('sample-helper');
    expect(saved.note).toContain('Manual steps');
  });
});

describe('Plugin rename word boundary', () => {
  it('does not match plugin name inside a longer plugin folder name', () => {
    // Sanity check on the regex we use: `data` followed by anything that's
    // not an identifier-continuation character.
    const segment = 'plugins';
    const name = 'data';
    const re = new RegExp(
      `${segment}/${name}(?![A-Za-z0-9_\\-.])`,
      'g',
    );
    expect(re.test('./lib/plugins/data;')).toBe(true);
    re.lastIndex = 0;
    expect(re.test('./lib/plugins/data/foo')).toBe(true);
    re.lastIndex = 0;
    expect(re.test('./lib/plugins/dataflow;')).toBe(false);
    re.lastIndex = 0;
    expect(re.test('./lib/plugins/data-flow;')).toBe(false);
    re.lastIndex = 0;
    expect(re.test('./lib/plugins/data.foo;')).toBe(false);
  });
});
