import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSyntheticPlan } from '../synthetic-plan.ts';
import { FileChangeType } from '../file-change.ts';
import type { IGenerationPlan } from '../generation-plan.ts';

function planWith(contents: string, root: string): IGenerationPlan {
  const abs = join(root, 'out.ts');
  return {
    templateId: '__delegate/test',
    templateName: '__delegate/test',
    changes: [
      {
        type: FileChangeType.Create,
        absolutePath: abs,
        relativePath: 'out.ts',
        contents,
        reason: 'test',
        sizeBytes: Buffer.byteLength(contents),
      },
    ],
    totalFiles: 1,
    hasConflicts: false,
    warnings: [],
    postGenerationNotes: [],
  };
}

describe('writeSyntheticPlan — CCR-marker write guard', () => {
  test('refuses to write contents carrying a <<ccr:…>> marker (nothing written)', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-ccr-guard-'));
    try {
      const r = writeSyntheticPlan(planWith("export const x = '<<ccr:deadbeef99 42 rows>>';\n", root));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toContain('<<ccr:');
      expect(existsSync(join(root, 'out.ts'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('writes clean contents normally', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-ccr-guard-ok-'));
    try {
      const r = writeSyntheticPlan(planWith("export const x = 1;\n", root));
      expect(r.ok).toBe(true);
      expect(readFileSync(join(root, 'out.ts'), 'utf8')).toContain('export const x = 1;');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
