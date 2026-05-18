import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { buildDocsCheck, buildExamplesCheck } from '../index.ts';

describe('r16 docs/examples check', () => {
  test('reports missing canonical docs', () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'r16-docs-'));
    const report = buildDocsCheck(root);
    expect(report.ok).toBe(false);
    expect(report.findings.some((f) => f.code === 'required-doc-missing')).toBe(true);
  });
  test('valid repo passes docs check', () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'r16-docs-good-'));
    mkdirSync(nodePath.join(root, 'docs'), { recursive: true });
    for (const f of ['overview.md', 'philosophy.md', 'safety-model.md', 'testing.md']) {
      writeFileSync(nodePath.join(root, 'docs', f), '# ' + f + '\n', 'utf8');
    }
    writeFileSync(
      nodePath.join(root, 'README.md'),
      '# Demo\n\n## Quick demo\n\nshrk doctor\n\n## Onboard\n\n`shrk onboard --dry-run`\n\n## Safety\n\nMCP is read-only; the CLI is the only write path. SharkCraft never writes outside .sharkcraft/.\n',
      'utf8',
    );
    const report = buildDocsCheck(root);
    expect(report.ok).toBe(true);
  });
  test('examples check warns when examples/ missing', () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'r16-examples-'));
    const report = buildExamplesCheck(root);
    expect(report.findings.some((f) => f.code === 'examples-dir-missing')).toBe(true);
  });
  test('examples check flags destructive lines', () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'r16-examples-bad-'));
    mkdirSync(nodePath.join(root, 'examples', 'demo'), { recursive: true });
    writeFileSync(nodePath.join(root, 'examples', 'demo', 'package.json'), '{"name":"demo"}', 'utf8');
    writeFileSync(
      nodePath.join(root, 'examples', 'demo', 'evil.sh'),
      '#!/usr/bin/env bash\nrm -rf /\n',
      'utf8',
    );
    const report = buildExamplesCheck(root);
    expect(report.ok).toBe(false);
    expect(report.findings.some((f) => f.code === 'destructive-command-detected')).toBe(true);
  });
});
