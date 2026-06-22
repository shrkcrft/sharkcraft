import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import {
  analyzeImpact,
  analyzeTestImpact,
  inspectSharkcraft,
  suggestTestPathFor,
} from '../index.ts';

describe('impact + test-impact', () => {
  it('analyzes architecture impact', async () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-imp-'));
    try {
      writeFileSync(nodePath.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
      const inspection = await inspectSharkcraft({ cwd: root });
      const r = await analyzeImpact(inspection, { files: ['src/services/user.service.ts'] });
      expect(r.affectedFiles.length).toBe(1);
      expect(r.suggestedValidationCommands.length).toBeGreaterThan(0);
      expect(['low', 'medium', 'high', 'critical']).toContain(r.risk);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('suggests test paths and finds missing tests', async () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-imp-'));
    try {
      writeFileSync(nodePath.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0', scripts: { test: 'bun test' } }));
      const inspection = await inspectSharkcraft({ cwd: root });
      const r = analyzeTestImpact(inspection, { files: ['src/foo.ts', 'src/bar.tsx'] });
      expect(r.inputFiles.length).toBe(2);
      expect(r.missingTestFiles.length).toBeGreaterThan(0);
      expect(suggestTestPathFor('src/foo.ts')).toBe('tests/foo.spec.ts');
      expect(suggestTestPathFor('src/Bar.tsx')).toBe('src/Bar.test.tsx');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('never lists a source .ts file as its own test (no false 100% confidence)', async () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-imp-'));
    try {
      writeFileSync(
        nodePath.join(root, 'package.json'),
        JSON.stringify({ name: 'x', version: '0.0.0', scripts: { test: 'bun test' } }),
      );
      // A real source file on disk with no matching test. The `.tsx` no-op
      // pattern used to echo this back as its own test (exists → confidence
      // 100%, runs zero tests).
      writeFileSync(nodePath.join(root, 'thing.ts'), 'export const x = 1;\n');
      const inspection = await inspectSharkcraft({ cwd: root });
      const r = analyzeTestImpact(inspection, { files: ['thing.ts'] });
      expect(r.likelyTestFiles).not.toContain('thing.ts');
      expect(r.confidence).toBe(0);
      expect(r.missingTestFiles.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
