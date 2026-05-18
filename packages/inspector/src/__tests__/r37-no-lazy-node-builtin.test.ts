/**
 * No lazy `require('node:*')` policy.
 *
 * - require('node:fs') now error-severity (was warning in ).
 *   - Allowlist still downgrades to info.
 *   - String-literal occurrences inside test fixtures are NOT flagged
 *     (the checker scans real source, not embedded test data).
 *   - The engine itself has zero runtime-require findings (regression
 *     guard — proves the cleanup actually happened and stays clean).
 *   - The sharkcraft rule `repo.imports.no-lazy-node-builtin-require`
 *     is registered with the right shape.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';

import {
  buildImportHygieneReport,
  ImportHygieneFindingKind,
} from '../import-hygiene.ts';
import { inspectSharkcraft } from '../sharkcraft-inspector.ts';

function mkProject(): string {
  return mkdtempSync(nodePath.join(tmpdir(), 'shrk-r37-'));
}

describe('require(node:*) is error-severity', () => {
  it('flags require(node:fs) as error', () => {
    const root = mkProject();
    const pkg = nodePath.join(root, 'packages', 'demo', 'src');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      nodePath.join(pkg, 'a.ts'),
      `function x() {\n  const { readdirSync } = require('node:fs') as typeof import('node:fs');\n  return readdirSync('/tmp');\n}\nexport { x };\n`,
      'utf8',
    );
    const report = buildImportHygieneReport(root, { skipAllowlist: true });
    const req = report.findings.find(
      (f) => f.kind === ImportHygieneFindingKind.RuntimeRequire,
    );
    expect(req).toBeDefined();
    expect(req?.severity).toBe('error');
    expect(report.verdict).toBe('errors');
  });

  it('flags require(node:path) and require(node:crypto) too — every builtin', () => {
    const root = mkProject();
    const pkg = nodePath.join(root, 'packages', 'demo', 'src');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      nodePath.join(pkg, 'a.ts'),
      `const p = require('node:path');\nconst c = require('node:crypto');\nexport { p, c };\n`,
      'utf8',
    );
    const report = buildImportHygieneReport(root, { skipAllowlist: true });
    const requires = report.findings.filter(
      (f) => f.kind === ImportHygieneFindingKind.RuntimeRequire,
    );
    expect(requires.length).toBe(2);
    expect(requires.every((f) => f.severity === 'error')).toBe(true);
  });

  it('allowlist still downgrades to info', () => {
    const root = mkProject();
    const pkg = nodePath.join(root, 'packages', 'demo', 'src');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      nodePath.join(pkg, 'a.ts'),
      `const fs = require('node:fs');\nexport const x = fs;\n`,
      'utf8',
    );
    const allowlistFile = nodePath.join(root, 'allow.json');
    writeFileSync(
      allowlistFile,
      JSON.stringify({
        allow: [
          {
            path: 'packages/demo/src/a.ts',
            kind: 'runtime-require',
            reason: 'test allowlist entry — documented intent',
          },
        ],
      }),
      'utf8',
    );
    const report = buildImportHygieneReport(root, { allowlistFile });
    const req = report.findings.find(
      (f) => f.kind === ImportHygieneFindingKind.RuntimeRequire,
    );
    expect(req?.allowlisted).toBe(true);
    expect(req?.severity).toBe('info');
    expect(req?.reason).toBe('test allowlist entry — documented intent');
  });

  it('engine has zero runtime-require errors (regression guard)', () => {
    const repoRoot = nodePath.resolve(__dirname, '..', '..', '..', '..');
    const report = buildImportHygieneReport(repoRoot);
    const requireErrors = report.findings.filter(
      (f) =>
        f.kind === ImportHygieneFindingKind.RuntimeRequire &&
        f.severity === 'error',
    );
    if (requireErrors.length > 0) {
      const summary = requireErrors
        .map((f) => `${f.file}:${f.line} → ${f.snippet}`)
        .join('\n');
      throw new Error(
        `Lazy require regression: ${requireErrors.length} lazy require finding(s) in the engine:\n${summary}`,
      );
    }
    expect(requireErrors.length).toBe(0);
  });
});

describe('rule registration', () => {
  it('repo.imports.no-lazy-node-builtin-require rule is loaded', async () => {
    const repoRoot = nodePath.resolve(__dirname, '..', '..', '..', '..');
    const inspection = await inspectSharkcraft({ cwd: repoRoot });
    const rules = inspection.knowledgeEntries.filter(
      (e) => e.type === 'rule' && e.id === 'repo.imports.no-lazy-node-builtin-require',
    );
    expect(rules.length).toBe(1);
    const rule = rules[0]!;
    expect(rule.priority).toBe('critical');
    expect(rule.actionHints?.verificationCommands).toContain('shrk check imports');
    expect((rule.actionHints?.forbiddenActions ?? []).join(' ')).toContain(
      "require('node:fs')",
    );
  });
});
