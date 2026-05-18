import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inferTemplateBody } from '../template-body-inference.ts';

function makeFixtureRoot(): string {
  return mkdtempSync(join(tmpdir(), 'shrk-tbody-'));
}

describe('inferTemplateBody', () => {
  test('replaces a service class name with <className>', () => {
    const root = makeFixtureRoot();
    mkdirSync(join(root, 'src', 'services'), { recursive: true });
    const sample = 'src/services/user.service.ts';
    writeFileSync(
      join(root, sample),
      `export class UserService {\n  greet(): string { return 'hi'; }\n}\n`,
    );

    const result = inferTemplateBody({
      projectRoot: root,
      sample,
      kind: 'service',
    });
    expect(result.scaffold).not.toBeNull();
    const s = result.scaffold!;
    expect(s.targetPath).toBe('src/services/<name>.service.ts');
    expect(s.content).toContain('<className>');
    expect(s.content).not.toContain('UserService');
    expect(s.variables.map((v) => v.name)).toContain('className');
    expect(s.variables.map((v) => v.name)).toContain('name');
    const nameVar = s.variables.find((v) => v.name === 'name')!;
    expect(nameVar.default).toBe('user');
    expect(s.confidence).toBe('high');
  });

  test('replaces a utility function name with <fnName>', () => {
    const root = makeFixtureRoot();
    mkdirSync(join(root, 'src', 'utils'), { recursive: true });
    const sample = 'src/utils/format-email.util.ts';
    writeFileSync(
      join(root, sample),
      `export function formatEmail(addr: string): string {\n  return addr.trim().toLowerCase();\n}\n`,
    );

    const result = inferTemplateBody({
      projectRoot: root,
      sample,
      kind: 'utility',
    });
    expect(result.scaffold).not.toBeNull();
    const s = result.scaffold!;
    expect(s.content).toContain('<fnName>');
    expect(s.content).not.toContain('formatEmail');
    const nameVar = s.variables.find((v) => v.name === 'name')!;
    expect(nameVar.default).toBe('format-email');
  });

  test('handles a test file with name extraction', () => {
    const root = makeFixtureRoot();
    mkdirSync(join(root, 'tests'), { recursive: true });
    const sample = 'tests/format-email.spec.ts';
    writeFileSync(
      join(root, sample),
      `import { test } from 'bun:test';\ntest('formatEmail trims', () => {});\n`,
    );

    const result = inferTemplateBody({
      projectRoot: root,
      sample,
      kind: 'test',
    });
    expect(result.scaffold).not.toBeNull();
    const s = result.scaffold!;
    expect(s.targetPath).toBe('tests/<name>.spec.ts');
    const nameVar = s.variables.find((v) => v.name === 'name')!;
    expect(nameVar.default).toBe('format-email');
  });

  test('skips large files', () => {
    const root = makeFixtureRoot();
    mkdirSync(join(root, 'src', 'services'), { recursive: true });
    const sample = 'src/services/giant.service.ts';
    writeFileSync(
      join(root, sample),
      `export class GiantService {}\n` + 'x'.repeat(50_000),
    );

    const result = inferTemplateBody({
      projectRoot: root,
      sample,
      kind: 'service',
    });
    expect(result.scaffold).toBeNull();
    expect(result.reason).toContain('too large');
  });

  test('marks low-confidence when sample is shaped wrong', () => {
    const root = makeFixtureRoot();
    mkdirSync(join(root, 'src', 'services'), { recursive: true });
    const sample = 'src/services/odd.service.ts';
    // No class — service kind expects a class declaration.
    writeFileSync(
      join(root, sample),
      `export const greeting = (name: string) => 'hi';\n`,
    );

    const result = inferTemplateBody({
      projectRoot: root,
      sample,
      kind: 'service',
    });
    expect(result.scaffold).not.toBeNull();
    expect(result.scaffold!.confidence).toBe('medium');
    expect(result.scaffold!.warnings.length).toBeGreaterThan(0);
  });

  test('refuses to scaffold files with many domain-specific literals', () => {
    const root = makeFixtureRoot();
    mkdirSync(join(root, 'src', 'services'), { recursive: true });
    const sample = 'src/services/customer.service.ts';
    const literals = Array.from(
      { length: 30 },
      (_, i) => `'customer literal ${i}'`,
    ).join(', ');
    writeFileSync(
      join(root, sample),
      `export class CustomerService { all = [${literals}]; }\n`,
    );

    const result = inferTemplateBody({
      projectRoot: root,
      sample,
      kind: 'service',
    });
    expect(result.scaffold).toBeNull();
    expect(result.reason).toContain('string literals');
  });
});
