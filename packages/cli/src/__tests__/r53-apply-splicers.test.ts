/**
 * Apply splicer round-trip tests.
 *
 *   - applyKnowledgeStaleFix: drops a matching reference from references[].
 *   - applyTemplateDriftFix: drops the unresolved id from related[].
 *   - applyTemplateUpdate: replaces top-level fields in place; refuses
 *     when nothing to apply.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import * as os from 'node:os';
import { applyKnowledgeStaleFix } from '../asset-preview/apply-knowledge-stale-fix.ts';
import { applyTemplateDriftFix } from '../asset-preview/apply-template-drift-fix.ts';
import { applyTemplateUpdate } from '../asset-preview/apply-template-update.ts';

function withTmp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(nodePath.join(os.tmpdir(), 'shrk-r53-'));
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
      { kind: 'symbol', symbol: 'OldName', path: 'packages/x/y.ts' },
      { kind: 'file', path: 'packages/z/q.ts' },
    ],
  },
]);
`;

const TEMPLATES_BODY = `export const sample = {
  id: 'team.sample',
  name: 'Sample',
  description: 'A sample template.',
  tags: ['team', 'sample'],
  scope: ['typescript'],
  appliesWhen: [],
  variables: [],
  related: ['team.style', 'team.unknown-related'],
  files: () => [],
};

export default [sample];
`;

describe('applyKnowledgeStaleFix', () => {
  test('preview (write=false) does not modify the target', () => {
    withTmp((dir) => {
      mkdirSync(nodePath.join(dir, 'sharkcraft'), { recursive: true });
      const target = nodePath.join(dir, 'sharkcraft', 'knowledge.ts');
      writeFileSync(target, KNOWLEDGE_BODY, 'utf8');
      const before = readFileSync(target, 'utf8');
      const result = applyKnowledgeStaleFix({
        cwd: dir,
        targetPath: 'sharkcraft/knowledge.ts',
        entryId: 'team.style',
        reference: { kind: 'symbol', symbol: 'OldName', path: 'packages/x/y.ts' },
        write: false,
      });
      expect(result.ok).toBe(true);
      expect(result.wrote).toBe(false);
      expect(result.removedCount).toBe(1);
      expect(readFileSync(target, 'utf8')).toBe(before);
    });
  });

  test('write=true drops the matching reference', () => {
    withTmp((dir) => {
      mkdirSync(nodePath.join(dir, 'sharkcraft'), { recursive: true });
      const target = nodePath.join(dir, 'sharkcraft', 'knowledge.ts');
      writeFileSync(target, KNOWLEDGE_BODY, 'utf8');
      const result = applyKnowledgeStaleFix({
        cwd: dir,
        targetPath: 'sharkcraft/knowledge.ts',
        entryId: 'team.style',
        reference: { kind: 'symbol', symbol: 'OldName', path: 'packages/x/y.ts' },
        write: true,
      });
      expect(result.ok).toBe(true);
      expect(result.wrote).toBe(true);
      const after = readFileSync(target, 'utf8');
      expect(after).not.toContain("symbol: 'OldName'");
      // Other references survive.
      expect(after).toContain("path: 'packages/z/q.ts'");
    });
  });

  test('refuses when the entry is not found', () => {
    withTmp((dir) => {
      mkdirSync(nodePath.join(dir, 'sharkcraft'), { recursive: true });
      writeFileSync(nodePath.join(dir, 'sharkcraft', 'knowledge.ts'), KNOWLEDGE_BODY, 'utf8');
      const result = applyKnowledgeStaleFix({
        cwd: dir,
        targetPath: 'sharkcraft/knowledge.ts',
        entryId: 'team.missing',
        reference: { kind: 'symbol', symbol: 'X', path: 'a.ts' },
        write: false,
      });
      expect(result.ok).toBe(false);
      expect(result.refusal).toMatch(/not found/);
    });
  });

  test('refuses path-escape on target', () => {
    withTmp((dir) => {
      const result = applyKnowledgeStaleFix({
        cwd: dir,
        targetPath: '../escape.ts',
        entryId: 'team.style',
        reference: { kind: 'symbol', symbol: 'X' },
        write: false,
      });
      expect(result.ok).toBe(false);
      expect(result.refusal).toMatch(/escape/);
    });
  });

  test('idempotent — second call removes nothing', () => {
    withTmp((dir) => {
      mkdirSync(nodePath.join(dir, 'sharkcraft'), { recursive: true });
      const target = nodePath.join(dir, 'sharkcraft', 'knowledge.ts');
      writeFileSync(target, KNOWLEDGE_BODY, 'utf8');
      const first = applyKnowledgeStaleFix({
        cwd: dir,
        targetPath: 'sharkcraft/knowledge.ts',
        entryId: 'team.style',
        reference: { kind: 'symbol', symbol: 'OldName', path: 'packages/x/y.ts' },
        write: true,
      });
      expect(first.ok).toBe(true);
      const second = applyKnowledgeStaleFix({
        cwd: dir,
        targetPath: 'sharkcraft/knowledge.ts',
        entryId: 'team.style',
        reference: { kind: 'symbol', symbol: 'OldName', path: 'packages/x/y.ts' },
        write: true,
      });
      expect(second.ok).toBe(false);
      expect(second.refusal).toMatch(/already removed/);
    });
  });
});

describe('applyTemplateDriftFix', () => {
  test('drops the unresolved related id from the related[] array', () => {
    withTmp((dir) => {
      mkdirSync(nodePath.join(dir, 'sharkcraft'), { recursive: true });
      const target = nodePath.join(dir, 'sharkcraft', 'templates.ts');
      writeFileSync(target, TEMPLATES_BODY, 'utf8');
      const result = applyTemplateDriftFix({
        cwd: dir,
        targetPath: 'sharkcraft/templates.ts',
        templateId: 'team.sample',
        droppedRelatedId: 'team.unknown-related',
        write: true,
      });
      expect(result.ok).toBe(true);
      expect(result.wrote).toBe(true);
      const after = readFileSync(target, 'utf8');
      expect(after).not.toContain('team.unknown-related');
      expect(after).toContain('team.style'); // other related survives
    });
  });

  test('refuses when the template is not found', () => {
    withTmp((dir) => {
      mkdirSync(nodePath.join(dir, 'sharkcraft'), { recursive: true });
      writeFileSync(nodePath.join(dir, 'sharkcraft', 'templates.ts'), TEMPLATES_BODY, 'utf8');
      const result = applyTemplateDriftFix({
        cwd: dir,
        targetPath: 'sharkcraft/templates.ts',
        templateId: 'team.missing',
        droppedRelatedId: 'whatever',
        write: false,
      });
      expect(result.ok).toBe(false);
      expect(result.refusal).toMatch(/not found/);
    });
  });
});

describe('applyTemplateUpdate', () => {
  test('replaces top-level scalar fields (name, description)', () => {
    withTmp((dir) => {
      mkdirSync(nodePath.join(dir, 'sharkcraft'), { recursive: true });
      const target = nodePath.join(dir, 'sharkcraft', 'templates.ts');
      writeFileSync(target, TEMPLATES_BODY, 'utf8');
      const result = applyTemplateUpdate({
        cwd: dir,
        targetPath: 'sharkcraft/templates.ts',
        templateId: 'team.sample',
        fields: {
          name: 'Updated Sample',
          description: 'New description.',
        },
        write: true,
      });
      expect(result.ok).toBe(true);
      expect(result.wrote).toBe(true);
      expect(result.fieldChanges.map((f) => f.field).sort()).toEqual(['description', 'name']);
      const after = readFileSync(target, 'utf8');
      expect(after).toContain('Updated Sample');
      expect(after).toContain('New description.');
      expect(after).not.toContain('A sample template.'); // original gone
    });
  });

  test('replaces array fields wholesale', () => {
    withTmp((dir) => {
      mkdirSync(nodePath.join(dir, 'sharkcraft'), { recursive: true });
      const target = nodePath.join(dir, 'sharkcraft', 'templates.ts');
      writeFileSync(target, TEMPLATES_BODY, 'utf8');
      const result = applyTemplateUpdate({
        cwd: dir,
        targetPath: 'sharkcraft/templates.ts',
        templateId: 'team.sample',
        fields: {
          tags: ['team', 'sample', 'r53'],
        },
        write: true,
      });
      expect(result.ok).toBe(true);
      const after = readFileSync(target, 'utf8');
      expect(after).toContain('"r53"');
    });
  });

  test('refuses when there are no supported fields to apply', () => {
    withTmp((dir) => {
      mkdirSync(nodePath.join(dir, 'sharkcraft'), { recursive: true });
      const target = nodePath.join(dir, 'sharkcraft', 'templates.ts');
      writeFileSync(target, TEMPLATES_BODY, 'utf8');
      const result = applyTemplateUpdate({
        cwd: dir,
        targetPath: 'sharkcraft/templates.ts',
        templateId: 'team.sample',
        fields: {},
        write: false,
      });
      expect(result.ok).toBe(false);
      expect(result.refusal).toMatch(/No supported fields/);
    });
  });
});
