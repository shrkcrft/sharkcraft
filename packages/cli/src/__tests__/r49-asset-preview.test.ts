/**
 * `shrk apply --asset-preview <draft> --target <file>` flow.
 *
 * Verifies the paste-with-review path: dry-run safety, path-escape
 * rejection, unknown-target gate, draft insertion before the closing
 * `]`, provenance recording when `--write`.
 */
import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as nodePath from 'node:path';
import * as os from 'node:os';
import { applyAssetPreview } from '../asset-preview/apply-asset-preview.ts';

function withTmp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(nodePath.join(os.tmpdir(), 'shrk-asset-preview-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const TARGET_BODY = `import { defineKnowledge } from '@shrkcrft/knowledge';

export default defineKnowledge([
  {
    id: 'team.style',
    summary: 'Team style guide',
  },
]);
`;

const DRAFT_BODY = `{
  id: 'team.review-checklist',
  summary: 'Review checklist',
  priority: 'medium',
}`;

describe('applyAssetPreview', () => {
  test('dry-run does not modify the target file', () => {
    withTmp((dir) => {
      mkdirSync(nodePath.join(dir, 'sharkcraft'), { recursive: true });
      const draft = nodePath.join(dir, 'draft.ts');
      const target = nodePath.join(dir, 'sharkcraft', 'knowledge.ts');
      writeFileSync(draft, DRAFT_BODY, 'utf8');
      writeFileSync(target, TARGET_BODY, 'utf8');

      const before = readFileSync(target, 'utf8');
      const result = applyAssetPreview({
        cwd: dir,
        draftPath: 'draft.ts',
        targetPath: 'sharkcraft/knowledge.ts',
        write: false,
        allowUnknownTarget: false,
      });
      expect(result.ok).toBe(true);
      expect(result.wrote).toBe(false);
      const after = readFileSync(target, 'utf8');
      expect(after).toBe(before);
      expect(result.diff?.added).toBeGreaterThan(0);
    });
  });

  test('--write inserts the draft into the array', () => {
    withTmp((dir) => {
      mkdirSync(nodePath.join(dir, 'sharkcraft'), { recursive: true });
      const draft = nodePath.join(dir, 'draft.ts');
      const target = nodePath.join(dir, 'sharkcraft', 'knowledge.ts');
      writeFileSync(draft, DRAFT_BODY, 'utf8');
      writeFileSync(target, TARGET_BODY, 'utf8');

      const result = applyAssetPreview({
        cwd: dir,
        draftPath: 'draft.ts',
        targetPath: 'sharkcraft/knowledge.ts',
        write: true,
        allowUnknownTarget: false,
      });
      expect(result.ok).toBe(true);
      expect(result.wrote).toBe(true);
      const after = readFileSync(target, 'utf8');
      expect(after).toContain("'team.review-checklist'");
      expect(after).toContain("'team.style'"); // existing entry preserved
      // The new entry should appear before the closing `])`.
      const closeIdx = after.lastIndexOf(']');
      const insertIdx = after.indexOf("'team.review-checklist'");
      expect(insertIdx).toBeGreaterThan(0);
      expect(insertIdx).toBeLessThan(closeIdx);
    });
  });

  test('rejects path-escape on --target', () => {
    withTmp((dir) => {
      const draft = nodePath.join(dir, 'draft.ts');
      writeFileSync(draft, DRAFT_BODY, 'utf8');
      const result = applyAssetPreview({
        cwd: dir,
        draftPath: 'draft.ts',
        targetPath: '../escape.ts',
        write: false,
        allowUnknownTarget: false,
      });
      expect(result.ok).toBe(false);
      expect(result.refusal).toContain('escape');
    });
  });

  test('rejects unknown asset type unless --allow-unknown-target', () => {
    withTmp((dir) => {
      const draft = nodePath.join(dir, 'draft.ts');
      const target = nodePath.join(dir, 'random.ts');
      writeFileSync(draft, DRAFT_BODY, 'utf8');
      writeFileSync(target, 'export default [];\n', 'utf8');
      const refused = applyAssetPreview({
        cwd: dir,
        draftPath: 'draft.ts',
        targetPath: 'random.ts',
        write: false,
        allowUnknownTarget: false,
      });
      expect(refused.ok).toBe(false);
      expect(refused.refusal).toContain('not a known asset');

      const allowed = applyAssetPreview({
        cwd: dir,
        draftPath: 'draft.ts',
        targetPath: 'random.ts',
        write: false,
        allowUnknownTarget: true,
      });
      expect(allowed.ok).toBe(true);
    });
  });

  test('missing draft file is refused with a clear message', () => {
    withTmp((dir) => {
      mkdirSync(nodePath.join(dir, 'sharkcraft'), { recursive: true });
      writeFileSync(nodePath.join(dir, 'sharkcraft', 'knowledge.ts'), TARGET_BODY, 'utf8');
      const result = applyAssetPreview({
        cwd: dir,
        draftPath: 'nonexistent.ts',
        targetPath: 'sharkcraft/knowledge.ts',
        write: false,
        allowUnknownTarget: false,
      });
      expect(result.ok).toBe(false);
      expect(result.refusal).toContain('Draft file not found');
    });
  });

  test('missing target file is refused with a clear message', () => {
    withTmp((dir) => {
      const draft = nodePath.join(dir, 'draft.ts');
      writeFileSync(draft, DRAFT_BODY, 'utf8');
      const result = applyAssetPreview({
        cwd: dir,
        draftPath: 'draft.ts',
        targetPath: 'sharkcraft/missing.ts',
        write: false,
        allowUnknownTarget: false,
      });
      expect(result.ok).toBe(false);
      expect(result.refusal).toContain('Target file not found');
    });
  });

  test('validation commands include the kind-aware one', () => {
    withTmp((dir) => {
      mkdirSync(nodePath.join(dir, 'sharkcraft'), { recursive: true });
      writeFileSync(nodePath.join(dir, 'draft.ts'), DRAFT_BODY, 'utf8');
      writeFileSync(nodePath.join(dir, 'sharkcraft', 'rules.ts'), 'export default [];\n', 'utf8');
      const result = applyAssetPreview({
        cwd: dir,
        draftPath: 'draft.ts',
        targetPath: 'sharkcraft/rules.ts',
        write: false,
        allowUnknownTarget: false,
      });
      expect(result.ok).toBe(true);
      expect(result.validationCommands).toContain('shrk rules lint');
    });
  });
});
