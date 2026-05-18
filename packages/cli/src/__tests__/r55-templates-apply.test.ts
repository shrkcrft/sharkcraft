/**
 * Templates update --apply: array merge modes + metadata splicing.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import * as os from 'node:os';
import { applyTemplateUpdate } from '../asset-preview/apply-template-update.ts';

function withTmp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(nodePath.join(os.tmpdir(), 'shrk-r55-tmpl-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const TEMPLATE_BODY = `import { defineTemplates } from '@shrkcrft/templates';

export default defineTemplates([
  {
    id: 'team.x',
    name: 'Team X',
    description: 'desc',
    tags: ['alpha', 'beta'],
    scope: ['typescript'],
    metadata: {
      priority: 'high',
      forbiddenPathFragments: ['legacy/foo'],
    },
  },
]);
`;

function write(dir: string): string {
  mkdirSync(nodePath.join(dir, 'sharkcraft'), { recursive: true });
  const t = nodePath.join(dir, 'sharkcraft', 'templates.ts');
  writeFileSync(t, TEMPLATE_BODY, 'utf8');
  return 'sharkcraft/templates.ts';
}

describe('apply-template-update array merge modes', () => {
  test('mode add merges tags without duplication', () => {
    withTmp((dir) => {
      const target = write(dir);
      const r = applyTemplateUpdate({
        cwd: dir,
        targetPath: target,
        templateId: 'team.x',
        fields: { tags: { mode: 'add', values: ['gamma', 'alpha'] } },
        write: true,
      });
      expect(r.ok).toBe(true);
      const after = readFileSync(nodePath.join(dir, target), 'utf8');
      // Order preserved + new tag appended; no duplicate alpha.
      expect(after).toMatch(/tags:\s*\[\s*"alpha",\s*"beta",\s*"gamma"\s*\]/);
    });
  });

  test('mode remove drops the requested tags', () => {
    withTmp((dir) => {
      const target = write(dir);
      const r = applyTemplateUpdate({
        cwd: dir,
        targetPath: target,
        templateId: 'team.x',
        fields: { tags: { mode: 'remove', values: ['beta'] } },
        write: true,
      });
      expect(r.ok).toBe(true);
      const after = readFileSync(nodePath.join(dir, target), 'utf8');
      expect(after).toMatch(/tags:\s*\[\s*"alpha"\s*\]/);
    });
  });

  test('mode set wholesale-replaces the array (back-compat)', () => {
    withTmp((dir) => {
      const target = write(dir);
      const r = applyTemplateUpdate({
        cwd: dir,
        targetPath: target,
        templateId: 'team.x',
        fields: { tags: { mode: 'set', values: ['only'] } },
        write: true,
      });
      expect(r.ok).toBe(true);
      const after = readFileSync(nodePath.join(dir, target), 'utf8');
      expect(after).toMatch(/tags:\s*\[\s*"only"\s*\]/);
    });
  });

  test('bare array is treated as mode=set (back-compat)', () => {
    withTmp((dir) => {
      const target = write(dir);
      const r = applyTemplateUpdate({
        cwd: dir,
        targetPath: target,
        templateId: 'team.x',
        fields: { tags: ['just-this'] },
        write: true,
      });
      expect(r.ok).toBe(true);
      const after = readFileSync(nodePath.join(dir, target), 'utf8');
      expect(after).toMatch(/tags:\s*\[\s*"just-this"\s*\]/);
    });
  });
});

describe('apply-template-update metadata splicing', () => {
  test('adds to metadata.forbiddenPathFragments via merge', () => {
    withTmp((dir) => {
      const target = write(dir);
      const r = applyTemplateUpdate({
        cwd: dir,
        targetPath: target,
        templateId: 'team.x',
        fields: {
          metadata: {
            forbiddenPathFragments: { mode: 'add', values: ['legacy/bar'] },
          },
        },
        write: true,
      });
      expect(r.ok).toBe(true);
      expect(r.fieldChanges.some((f) => f.field === 'metadata.forbiddenPathFragments')).toBe(true);
      const after = readFileSync(nodePath.join(dir, target), 'utf8');
      expect(after).toMatch(/forbiddenPathFragments:\s*\[\s*"legacy\/foo",\s*"legacy\/bar"\s*\]/);
    });
  });

  test('replaces a metadata scalar field (priority)', () => {
    withTmp((dir) => {
      const target = write(dir);
      const r = applyTemplateUpdate({
        cwd: dir,
        targetPath: target,
        templateId: 'team.x',
        fields: { metadata: { priority: 'low' } },
        write: true,
      });
      expect(r.ok).toBe(true);
      expect(r.fieldChanges.some((f) => f.field === 'metadata.priority')).toBe(true);
      const after = readFileSync(nodePath.join(dir, target), 'utf8');
      expect(after).toContain('priority: "low"');
    });
  });

  test('creates the metadata block when absent', () => {
    withTmp((dir) => {
      const noMetaBody = TEMPLATE_BODY.replace(
        /metadata:\s*\{[\s\S]*?\},/,
        '',
      );
      mkdirSync(nodePath.join(dir, 'sharkcraft'), { recursive: true });
      const t = nodePath.join(dir, 'sharkcraft', 'templates.ts');
      writeFileSync(t, noMetaBody, 'utf8');
      const r = applyTemplateUpdate({
        cwd: dir,
        targetPath: 'sharkcraft/templates.ts',
        templateId: 'team.x',
        fields: { metadata: { requiredAnchors: { mode: 'set', values: ['symbol'] } } },
        write: true,
      });
      expect(r.ok).toBe(true);
      const after = readFileSync(t, 'utf8');
      expect(after).toContain('metadata: {');
      expect(after).toContain('requiredAnchors: ["symbol"]');
    });
  });
});
