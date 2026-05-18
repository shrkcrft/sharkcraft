/**
 * apply-action-hint-stub: entry-aware splicer for `shrk fix
 * --action-hints --apply`.
 *
 * Locks in: idempotency, divergence refusal, path-escape rejection,
 * round-trip (the splice produces the actionHints field; doctor's
 * missing-action-hints warning would drop after running the splicer).
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import * as os from 'node:os';
import { applyActionHintStub } from '../asset-preview/apply-action-hint-stub.ts';

function withTmp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(nodePath.join(os.tmpdir(), 'shrk-r52-stub-'));
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
    summary: 'Team style guide',
    content: 'Use Result + AppErrorImpl on public APIs.',
  },
  {
    id: 'team.review',
    title: 'Team review',
    type: 'documentation',
    priority: 'medium',
    summary: 'Review checklist',
    content: 'Two reviewers required.',
  },
]);
`;

const WITH_HINTS_BODY = `import { defineKnowledge } from '@shrkcrft/knowledge';

export default defineKnowledge([
  {
    id: 'team.style',
    title: 'Team style',
    type: 'rule',
    priority: 'high',
    summary: 'Team style guide',
    content: 'Use Result + AppErrorImpl on public APIs.',
    actionHints: {
      commands: [{ command: 'shrk doctor' }],
      verificationCommands: [],
      forbiddenActions: [],
    },
  },
]);
`;

describe('applyActionHintStub', () => {
  test('preview (write=false) does not modify the target file', () => {
    withTmp((dir) => {
      mkdirSync(nodePath.join(dir, 'sharkcraft'), { recursive: true });
      writeFileSync(nodePath.join(dir, 'sharkcraft', 'knowledge.ts'), KNOWLEDGE_BODY, 'utf8');
      const before = readFileSync(nodePath.join(dir, 'sharkcraft', 'knowledge.ts'), 'utf8');
      const result = applyActionHintStub({
        cwd: dir,
        targetPath: 'sharkcraft/knowledge.ts',
        entryId: 'team.style',
        write: false,
      });
      expect(result.ok).toBe(true);
      expect(result.wrote).toBe(false);
      const after = readFileSync(nodePath.join(dir, 'sharkcraft', 'knowledge.ts'), 'utf8');
      expect(after).toBe(before);
      expect(result.diff).toMatch(/\+\s*actionHints:/);
    });
  });

  test('write=true splices actionHints into the matching entry', () => {
    withTmp((dir) => {
      mkdirSync(nodePath.join(dir, 'sharkcraft'), { recursive: true });
      writeFileSync(nodePath.join(dir, 'sharkcraft', 'knowledge.ts'), KNOWLEDGE_BODY, 'utf8');
      const result = applyActionHintStub({
        cwd: dir,
        targetPath: 'sharkcraft/knowledge.ts',
        entryId: 'team.style',
        write: true,
      });
      expect(result.ok).toBe(true);
      expect(result.wrote).toBe(true);
      const after = readFileSync(nodePath.join(dir, 'sharkcraft', 'knowledge.ts'), 'utf8');
      expect(after).toContain('actionHints:');
      // Splice must be inside the team.style entry, NOT the team.review entry.
      const styleStart = after.indexOf("id: 'team.style'");
      const reviewStart = after.indexOf("id: 'team.review'");
      const hintsAt = after.indexOf('actionHints:');
      expect(hintsAt).toBeGreaterThan(styleStart);
      expect(hintsAt).toBeLessThan(reviewStart);
      // The second entry should be untouched.
      expect(after).toContain("id: 'team.review'");
    });
  });

  test('refuses on divergence — entry already has actionHints', () => {
    withTmp((dir) => {
      mkdirSync(nodePath.join(dir, 'sharkcraft'), { recursive: true });
      writeFileSync(
        nodePath.join(dir, 'sharkcraft', 'knowledge.ts'),
        WITH_HINTS_BODY,
        'utf8',
      );
      const result = applyActionHintStub({
        cwd: dir,
        targetPath: 'sharkcraft/knowledge.ts',
        entryId: 'team.style',
        write: false,
      });
      expect(result.ok).toBe(false);
      expect(result.refusal).toMatch(/already has an actionHints/);
    });
  });

  test('--allow-divergent forces the splice even when actionHints exists', () => {
    withTmp((dir) => {
      mkdirSync(nodePath.join(dir, 'sharkcraft'), { recursive: true });
      writeFileSync(
        nodePath.join(dir, 'sharkcraft', 'knowledge.ts'),
        WITH_HINTS_BODY,
        'utf8',
      );
      const result = applyActionHintStub({
        cwd: dir,
        targetPath: 'sharkcraft/knowledge.ts',
        entryId: 'team.style',
        write: false,
        allowDivergent: true,
      });
      expect(result.ok).toBe(true);
    });
  });

  test('refuses path escape', () => {
    withTmp((dir) => {
      const result = applyActionHintStub({
        cwd: dir,
        targetPath: '../escape.ts',
        entryId: 'team.style',
        write: false,
      });
      expect(result.ok).toBe(false);
      expect(result.refusal).toMatch(/escape/);
    });
  });

  test('refuses when the entry id is not present in the target', () => {
    withTmp((dir) => {
      mkdirSync(nodePath.join(dir, 'sharkcraft'), { recursive: true });
      writeFileSync(nodePath.join(dir, 'sharkcraft', 'knowledge.ts'), KNOWLEDGE_BODY, 'utf8');
      const result = applyActionHintStub({
        cwd: dir,
        targetPath: 'sharkcraft/knowledge.ts',
        entryId: 'team.nonexistent',
        write: false,
      });
      expect(result.ok).toBe(false);
      expect(result.refusal).toMatch(/not found/);
    });
  });

  test('refuses when the target file is missing', () => {
    withTmp((dir) => {
      const result = applyActionHintStub({
        cwd: dir,
        targetPath: 'sharkcraft/missing.ts',
        entryId: 'team.style',
        write: false,
      });
      expect(result.ok).toBe(false);
      expect(result.refusal).toMatch(/not found/);
    });
  });
});
