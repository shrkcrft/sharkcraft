import { describe, expect, test } from "bun:test";
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineTemplate } from '@shrkcrft/templates';
import { FileChangeType, generate, planGeneration } from '../index.ts';

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'shrk-safety-test-'));
}

const escapingTemplate = defineTemplate({
  id: 'escape',
  name: 'Escape attempt',
  description: 'Tries to write outside the project root.',
  tags: [],
  scope: [],
  appliesWhen: [],
  variables: [],
  targetPath: () => '../../../tmp/owned.ts',
  content: () => '// pwned\n',
});

const absoluteTemplate = defineTemplate({
  id: 'absolute',
  name: 'Absolute path',
  description: 'Tries an absolute target path.',
  tags: [],
  scope: [],
  appliesWhen: [],
  variables: [],
  targetPath: () => '/etc/passwd',
  content: () => 'bad\n',
});

const safeTemplate = defineTemplate({
  id: 'safe',
  name: 'Safe',
  description: 'Writes inside the project root.',
  tags: [],
  scope: [],
  appliesWhen: [],
  variables: [],
  targetPath: () => 'src/x.ts',
  content: () => 'export const x = 1;\n',
});

describe('path-safety in planGeneration', () => {
  test('refuses ../ traversal', () => {
    const root = makeRoot();
    const dry = planGeneration(escapingTemplate, {
      templateId: 'escape',
      variables: {},
      projectRoot: root,
    });
    expect(dry.plan.hasConflicts).toBe(true);
    const conflict = dry.plan.changes[0]!;
    expect(conflict.type).toBe(FileChangeType.Conflict);
    expect(conflict.reason).toContain('Refused unsafe target path');
  });

  test('refuses absolute paths', () => {
    const root = makeRoot();
    const dry = planGeneration(absoluteTemplate, {
      templateId: 'absolute',
      variables: {},
      projectRoot: root,
    });
    expect(dry.plan.hasConflicts).toBe(true);
    expect(dry.plan.changes[0]?.reason).toContain('absolute-path-rejected');
  });

  test('write refuses to apply a conflicting plan', () => {
    const root = makeRoot();
    const result = generate(escapingTemplate, {
      templateId: 'escape',
      variables: {},
      projectRoot: root,
      write: true,
    });
    expect(result.ok).toBe(false);
  });

  test('dry-run never writes', () => {
    const root = makeRoot();
    const result = generate(safeTemplate, {
      templateId: 'safe',
      variables: {},
      projectRoot: root,
      write: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.summary.written).toBe(0);
    }
  });
});
