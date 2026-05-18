import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineTemplate } from '@shrkcrft/templates';
import { buildNameVariables, FileChangeType, generate, OverwriteStrategy, planGeneration } from '../index.ts';

function makeTmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'shrk-gen-test-'));
}

const tsService = defineTemplate({
  id: 'typescript.service',
  name: 'Service',
  description: 'Test service',
  tags: ['ts'],
  scope: ['ts'],
  appliesWhen: ['gen-service'],
  variables: [
    { name: 'name', required: true },
    { name: 'className', required: true },
  ],
  targetPath: ({ name }) => `src/services/${name}.service.ts`,
  content: ({ className }) => `export class ${className} {}\n`,
});

describe('planGeneration', () => {
  test('produces a CREATE plan for new file', () => {
    const root = makeTmpProject();
    const dry = planGeneration(tsService, {
      templateId: tsService.id,
      name: 'user-profile',
      variables: {},
      projectRoot: root,
    });
    expect(dry.plan.totalFiles).toBe(1);
    expect(dry.plan.changes[0]?.type).toBe(FileChangeType.Create);
    expect(dry.plan.hasConflicts).toBe(false);
    expect(dry.safe).toBe(true);
  });

  test('reports SKIP for identical existing file', () => {
    const root = makeTmpProject();
    mkdirSync(join(root, 'src/services'), { recursive: true });
    writeFileSync(join(root, 'src/services/user-profile.service.ts'), 'export class UserProfile {}\n');
    const dry = planGeneration(tsService, {
      templateId: tsService.id,
      name: 'user-profile',
      variables: {},
      projectRoot: root,
    });
    expect(dry.plan.changes[0]?.type).toBe(FileChangeType.Skip);
  });

  test('reports CONFLICT for differing existing file', () => {
    const root = makeTmpProject();
    mkdirSync(join(root, 'src/services'), { recursive: true });
    writeFileSync(join(root, 'src/services/user-profile.service.ts'), 'something different');
    const dry = planGeneration(tsService, {
      templateId: tsService.id,
      name: 'user-profile',
      variables: {},
      projectRoot: root,
    });
    expect(dry.plan.changes[0]?.type).toBe(FileChangeType.Conflict);
    expect(dry.plan.hasConflicts).toBe(true);
  });

  test('reports missing variables as warnings', () => {
    const root = makeTmpProject();
    const incomplete = defineTemplate({
      id: 'no-derive',
      name: 'No-derive',
      description: 'Requires explicit',
      tags: [],
      scope: [],
      appliesWhen: [],
      variables: [{ name: 'requiredOne', required: true }],
      targetPath: 'src/x.ts',
      content: '// hi\n',
    });
    const dry = planGeneration(incomplete, {
      templateId: incomplete.id,
      variables: {},
      projectRoot: root,
    });
    expect(dry.plan.warnings.length).toBeGreaterThan(0);
    expect(dry.safe).toBe(false);
  });
});

describe('generate (write)', () => {
  test('refuses to write when conflicts exist', () => {
    const root = makeTmpProject();
    mkdirSync(join(root, 'src/services'), { recursive: true });
    writeFileSync(join(root, 'src/services/user-profile.service.ts'), 'something else');
    const result = generate(tsService, {
      templateId: tsService.id,
      name: 'user-profile',
      variables: {},
      projectRoot: root,
      write: true,
      overwriteStrategy: OverwriteStrategy.Never,
    });
    expect(result.ok).toBe(false);
  });

  test('dry-run returns plan only', () => {
    const root = makeTmpProject();
    const result = generate(tsService, {
      templateId: tsService.id,
      name: 'user-profile',
      variables: {},
      projectRoot: root,
      write: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.summary.written).toBe(0);
      expect(result.value.plan.changes.length).toBe(1);
    }
  });
});

describe('buildNameVariables', () => {
  test('derives case variations from a kebab name', () => {
    const vars = buildNameVariables('user-profile');
    expect(vars.kebab).toBe('user-profile');
    expect(vars.pascal).toBe('UserProfile');
    expect(vars.camel).toBe('userProfile');
    expect(vars.snake).toBe('user_profile');
    expect(vars.className).toBe('UserProfile');
  });
});
