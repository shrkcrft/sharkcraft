/**
 * Rename-in-place for knowledge-stale apply.
 *
 *   - applyKnowledgeStaleFix in rename mode rewrites the matching
 *     reference's path / id / symbol in place; other references
 *     survive; idempotent.
 *   - The rename mode is selected by passing `renameTo`. Without it,
 * the splicer still defaults to drop ( behavior preserved).
 *   - Pack-source refusal still applies (gated by the caller in
 *     fix.command.ts; the splicer itself is path-blind).
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import * as os from 'node:os';
import { applyKnowledgeStaleFix } from '../asset-preview/apply-knowledge-stale-fix.ts';

function withTmp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(nodePath.join(os.tmpdir(), 'shrk-r54-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const KNOWLEDGE_BODY = `import { defineKnowledge } from '@shrkcrft/knowledge';

export default defineKnowledge([
  {
    id: 'team.style',
    title: 'Team style',
    type: 'rule',
    priority: 'high',
    content: 'X.',
    references: [
      { kind: 'symbol', symbol: 'CommandRegistry', path: 'packages/old/registry.ts' },
      { kind: 'file', path: 'packages/z/q.ts' },
    ],
  },
]);
`;

describe('applyKnowledgeStaleFix rename mode', () => {
  test('rewrites the symbol reference path in place', () => {
    withTmp((dir) => {
      mkdirSync(nodePath.join(dir, 'sharkcraft'), { recursive: true });
      const target = nodePath.join(dir, 'sharkcraft', 'knowledge.ts');
      writeFileSync(target, KNOWLEDGE_BODY, 'utf8');
      const result = applyKnowledgeStaleFix({
        cwd: dir,
        targetPath: 'sharkcraft/knowledge.ts',
        entryId: 'team.style',
        reference: {
          kind: 'symbol',
          symbol: 'CommandRegistry',
          path: 'packages/old/registry.ts',
        },
        renameTo: { path: 'packages/new/registry.ts' },
        write: true,
      });
      expect(result.ok).toBe(true);
      expect(result.mode).toBe('rename');
      expect(result.wrote).toBe(true);
      const after = readFileSync(target, 'utf8');
      expect(after).toContain("path: 'packages/new/registry.ts'");
      expect(after).not.toContain("path: 'packages/old/registry.ts'");
      // The symbol itself stays — only the path changed.
      expect(after).toContain("symbol: 'CommandRegistry'");
      // Other references survive.
      expect(after).toContain("path: 'packages/z/q.ts'");
    });
  });

  test('refuses when the reference is not found', () => {
    withTmp((dir) => {
      mkdirSync(nodePath.join(dir, 'sharkcraft'), { recursive: true });
      writeFileSync(nodePath.join(dir, 'sharkcraft', 'knowledge.ts'), KNOWLEDGE_BODY, 'utf8');
      const result = applyKnowledgeStaleFix({
        cwd: dir,
        targetPath: 'sharkcraft/knowledge.ts',
        entryId: 'team.style',
        reference: {
          kind: 'symbol',
          symbol: 'NotPresent',
          path: 'packages/old/registry.ts',
        },
        renameTo: { path: 'packages/new/registry.ts' },
        write: false,
      });
      expect(result.ok).toBe(false);
      expect(result.mode).toBe('rename');
      expect(result.refusal).toMatch(/not found/);
    });
  });

  test('idempotent — second rename to the same target refuses', () => {
    withTmp((dir) => {
      mkdirSync(nodePath.join(dir, 'sharkcraft'), { recursive: true });
      const target = nodePath.join(dir, 'sharkcraft', 'knowledge.ts');
      writeFileSync(target, KNOWLEDGE_BODY, 'utf8');
      const first = applyKnowledgeStaleFix({
        cwd: dir,
        targetPath: 'sharkcraft/knowledge.ts',
        entryId: 'team.style',
        reference: {
          kind: 'symbol',
          symbol: 'CommandRegistry',
          path: 'packages/old/registry.ts',
        },
        renameTo: { path: 'packages/new/registry.ts' },
        write: true,
      });
      expect(first.ok).toBe(true);
      // Re-running the same rename against the post-rename file should
      // refuse — the old path is gone.
      const second = applyKnowledgeStaleFix({
        cwd: dir,
        targetPath: 'sharkcraft/knowledge.ts',
        entryId: 'team.style',
        reference: {
          kind: 'symbol',
          symbol: 'CommandRegistry',
          path: 'packages/old/registry.ts',
        },
        renameTo: { path: 'packages/new/registry.ts' },
        write: true,
      });
      expect(second.ok).toBe(false);
    });
  });

  test('drop mode (no renameTo) preserves behavior', () => {
    withTmp((dir) => {
      mkdirSync(nodePath.join(dir, 'sharkcraft'), { recursive: true });
      const target = nodePath.join(dir, 'sharkcraft', 'knowledge.ts');
      writeFileSync(target, KNOWLEDGE_BODY, 'utf8');
      const result = applyKnowledgeStaleFix({
        cwd: dir,
        targetPath: 'sharkcraft/knowledge.ts',
        entryId: 'team.style',
        reference: {
          kind: 'symbol',
          symbol: 'CommandRegistry',
          path: 'packages/old/registry.ts',
        },
        write: true,
      });
      expect(result.ok).toBe(true);
      expect(result.mode).toBe('drop');
      expect(result.removedCount).toBe(1);
      const after = readFileSync(target, 'utf8');
      expect(after).not.toContain("symbol: 'CommandRegistry'");
      expect(after).toContain("path: 'packages/z/q.ts'");
    });
  });
});
