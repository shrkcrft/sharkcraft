import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import {
  buildPackDoctorReport,
  inspectSharkcraft,
  mergePackReleaseChecks,
  runPackReleaseCheck,
  runPackReleaseChecksForReport,
} from '../index.ts';

function makeMinimalPack(root: string, packDir: string): void {
  mkdirSync(packDir, { recursive: true });
  mkdirSync(nodePath.join(packDir, 'src/assets'), { recursive: true });
  writeFileSync(
    nodePath.join(packDir, 'package.json'),
    JSON.stringify(
      {
        name: 'r14-test-pack',
        version: '0.0.1',
        sharkcraft: { manifest: 'src/sharkcraft.plugin.signed.json' },
        files: ['src/**'],
      },
      null,
      2,
    ),
  );
  writeFileSync(nodePath.join(packDir, 'src/assets/knowledge.ts'), 'export default [];');
  writeFileSync(
    nodePath.join(packDir, 'src/sharkcraft.plugin.signed.json'),
    JSON.stringify(
      {
        schema: 'sharkcraft.pack/v1',
        info: { name: 'r14-test-pack', version: '0.0.1' },
        contributions: { knowledgeFiles: ['./src/assets/knowledge.ts'] },
        signature: { algorithm: 'HMAC-SHA256', value: 'deadbeef' },
      },
      null,
      2,
    ),
  );
  // Add a workspace package.json so discovery has something to anchor on.
  if (root) {
    writeFileSync(nodePath.join(root, 'package.json'), JSON.stringify({ name: 'r14-workspace', version: '0.0.0' }));
  }
}

describe('r14 packs doctor --release', () => {
  test('release-check passes on a minimal signed pack', async () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'sharkcraft-r14-pkg-doctor-'));
    const packDir = nodePath.join(root, 'packs/r14-test-pack');
    makeMinimalPack(root, packDir);
    const check = await runPackReleaseCheck(packDir);
    expect(check.findings.every((f) => f.severity !== 'error')).toBe(true);
  });

  test('every finding has a code + severity, fix suggestions when applicable', async () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'sharkcraft-r14-pkg-suggest-'));
    const packDir = nodePath.join(root, 'packs/r14-bad-pack');
    mkdirSync(packDir, { recursive: true });
    // package.json without files[] and a manifest reference that points nowhere.
    writeFileSync(
      nodePath.join(packDir, 'package.json'),
      JSON.stringify({
        name: 'bad',
        version: '0',
        sharkcraft: { manifest: 'missing.json' },
      }),
    );
    const check = await runPackReleaseCheck(packDir);
    expect(check.findings.length).toBeGreaterThan(0);
    for (const f of check.findings) {
      expect(typeof f.code).toBe('string');
      expect(['info', 'warning', 'error']).toContain(f.severity);
    }
    expect(check.findings.some((f) => f.suggestedFix || f.suggestedCommand)).toBe(true);
  });

  test('mergePackReleaseChecks folds findings into the doctor report', async () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'sharkcraft-r14-pkg-merge-'));
    writeFileSync(nodePath.join(root, 'package.json'), JSON.stringify({ name: 'r14-merge', version: '0' }));
    const inspection = await inspectSharkcraft({ cwd: root });
    const report = buildPackDoctorReport(inspection);
    const releaseChecks = await runPackReleaseChecksForReport(inspection);
    const merged = mergePackReleaseChecks(inspection, report, releaseChecks, { strict: false });
    expect(merged.releaseChecks).toBeDefined();
    expect(merged.summary).toBeDefined();
  });
});
