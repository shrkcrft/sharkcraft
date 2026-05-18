import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { buildReleaseReadiness, inspectSharkcraft } from '../index.ts';

describe('r17 release readiness strict additions', () => {
  test('flags missing release notes / limits / quickstart / changelog', async () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'r17-rr-strict-'));
    writeFileSync(
      nodePath.join(root, 'package.json'),
      JSON.stringify({ name: 'x', version: '0.1.0' }, null, 2),
      'utf8',
    );
    // No docs folder, no release notes — should warn.
    const inspection = await inspectSharkcraft({ cwd: root });
    const report = await buildReleaseReadiness(inspection, {});
    const warnCodes = report.warnings.map((c) => c.id);
    expect(warnCodes).toContain('release-notes');
    expect(warnCodes).toContain('public-alpha-limitations');
    expect(warnCodes).toContain('external-quickstart');
    expect(warnCodes).toContain('changelog');
  });
  test('accepts release notes + limits + quickstart + changelog when present', async () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'r17-rr-good-'));
    writeFileSync(
      nodePath.join(root, 'package.json'),
      JSON.stringify({ name: 'x', version: '0.1.0' }, null, 2),
      'utf8',
    );
    mkdirSync(nodePath.join(root, 'docs', 'releases'), { recursive: true });
    writeFileSync(nodePath.join(root, 'docs', 'releases', '0.1.0-alpha.2.md'), 'release', 'utf8');
    writeFileSync(nodePath.join(root, 'docs', 'public-alpha-limitations.md'), 'limits', 'utf8');
    writeFileSync(nodePath.join(root, 'docs', 'external-repo-quickstart.md'), 'quickstart', 'utf8');
    writeFileSync(nodePath.join(root, 'CHANGELOG.md'), 'changelog', 'utf8');
    const inspection = await inspectSharkcraft({ cwd: root });
    const report = await buildReleaseReadiness(inspection, {});
    const passIds = report.passed.map((c) => c.id);
    expect(passIds).toContain('release-notes');
    expect(passIds).toContain('public-alpha-limitations');
    expect(passIds).toContain('external-quickstart');
    expect(passIds).toContain('changelog');
  });
});
