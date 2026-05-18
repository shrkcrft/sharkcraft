import { describe, expect, test } from "bun:test";
import {
  defineTemplate,
  previewTemplate,
  renderTemplate,
  TemplateRegistry,
  validateTemplateVariables
} from '../index.ts';

const tsService = defineTemplate({
  id: 'typescript.service',
  name: 'TypeScript Service',
  description: 'A test service template.',
  tags: ['typescript', 'service'],
  scope: ['typescript'],
  appliesWhen: ['generate-service'],
  variables: [
    { name: 'name', required: true },
    { name: 'className', required: true, pattern: /^[A-Z][A-Za-z0-9]*$/ },
  ],
  targetPath: ({ name }) => `src/services/${name}.service.ts`,
  content: ({ className }) => `export class ${className} {}\n`,
  postGenerationNotes: ['Add tests.'],
});

const multiFile = defineTemplate({
  id: 'feature',
  name: 'Feature',
  description: 'Multi-file feature.',
  tags: ['feature'],
  scope: ['typescript'],
  appliesWhen: ['generate-feature'],
  variables: [{ name: 'name', required: true }],
  files: ({ name }) => [
    { targetPath: `src/${name}/index.ts`, content: `export const ${name} = true;\n` },
    { targetPath: `src/${name}/${name}.spec.ts`, content: `// test\n` },
  ],
});

describe('validateTemplateVariables', () => {
  test('passes when required vars are present', () => {
    const result = validateTemplateVariables(tsService.variables, {
      name: 'user-profile',
      className: 'UserProfile',
    });
    expect(result.valid).toBe(true);
    expect(result.issues.length).toBe(0);
  });

  test('reports missing required vars', () => {
    const result = validateTemplateVariables(tsService.variables, { name: 'x' });
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.variable).toBe('className');
  });

  test('enforces pattern', () => {
    const result = validateTemplateVariables(tsService.variables, {
      name: 'x',
      className: 'lower',
    });
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.variable).toBe('className');
  });
});

describe('renderTemplate', () => {
  test('renders single-file template', () => {
    const rendered = renderTemplate(tsService, {
      name: 'user-profile',
      className: 'UserProfile',
    });
    expect(rendered.files.length).toBe(1);
    expect(rendered.files[0]?.targetPath).toBe('src/services/user-profile.service.ts');
    expect(rendered.files[0]?.content).toBe('export class UserProfile {}\n');
  });

  test('renders multi-file template', () => {
    const rendered = renderTemplate(multiFile, { name: 'auth' });
    expect(rendered.files.length).toBe(2);
    expect(rendered.files.map((f) => f.targetPath)).toEqual([
      'src/auth/index.ts',
      'src/auth/auth.spec.ts',
    ]);
  });
});

describe('previewTemplate', () => {
  test('rejects when variables are invalid', () => {
    const preview = previewTemplate(tsService, { name: 'x' });
    expect(preview.validation.valid).toBe(false);
    expect(preview.rendered).toBe(null);
  });

  test('returns rendered files when valid', () => {
    const preview = previewTemplate(tsService, {
      name: 'order',
      className: 'OrderService',
    });
    expect(preview.validation.valid).toBe(true);
    expect(preview.rendered).not.toBe(null);
    expect(preview.rendered!.files[0]?.targetPath).toBe('src/services/order.service.ts');
  });
});

describe('TemplateRegistry', () => {
  test('register/get/list', () => {
    const reg = new TemplateRegistry([tsService, multiFile]);
    expect(reg.has('typescript.service')).toBe(true);
    expect(reg.get('feature')?.name).toBe('Feature');
    expect(reg.list().length).toBe(2);
  });

  test('search filters by query', () => {
    const reg = new TemplateRegistry([tsService, multiFile]);
    const results = reg.search('service');
    expect(results.some((t) => t.id === 'typescript.service')).toBe(true);
  });
});
