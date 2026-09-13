/**
 * Round 11 §3.2#4 + §4.6#3 — template lint renders `changes()` with sample
 * variables and checks every op against the generator's allow-list (a
 * key/value op crashed `gen` while lint said clean), and checks the declared
 * remainder vocabulary. Real templates.ts through `inspectSharkcraft`.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { extractVariablesForFile, inspectSharkcraft, lintTemplates } from '../index.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function write(root: string, rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

const TEMPLATES = `
const base = { tags: [], scope: [], appliesWhen: [], variables: [{ name: 'name', required: true, examples: ['foo'], description: 'n' }] };
export default [
  { ...base, id: 'reg.add', name: 'Register', description: 'Register a thing',
    changes: ({ name }) => [{ targetPath: 'src/registry.ts', operation: { kind: 'insert-array-entry', arrayName: 'ALL', key: name, value: "'" + name + "'" } }] },
  { ...base, id: 'mod.new', name: 'New module', description: 'Create a module',
    files: ({ name }) => [{ targetPath: 'packages/' + name + '/src/index.ts', content: 'export {};\\n' }] },
  { ...base, id: 'mod.declared', name: 'Declared module', description: 'Create a module',
    notScaffolded: ['build-config'],
    files: ({ name }) => [{ targetPath: 'packages/' + name + '/src/index.ts', content: 'export {};\\n' }] },
  { ...base, id: 'mod.bogus', name: 'Bogus remainder', description: 'Create a module',
    notScaffolded: ['bogus'], manualSteps: [{ description: '' }],
    files: () => [{ targetPath: 'src/x.ts', content: '' }] },
];
`;

async function lint(): Promise<ReturnType<typeof lintTemplates>> {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-tlint-'));
  roots.push(root);
  write(root, 'package.json', JSON.stringify({ name: 't', version: '0.0.0' }));
  write(root, 'sharkcraft/sharkcraft.config.ts', "export default { projectName: 't', templateFiles: ['templates.ts'] };\n");
  write(root, 'sharkcraft/templates.ts', TEMPLATES);
  write(root, 'src/registry.ts', 'export const ALL = [];\n');
  return lintTemplates(await inspectSharkcraft({ cwd: root }));
}

const issuesOf = (r: ReturnType<typeof lintTemplates>, id: string) => r.results.find((x) => x.templateId === id)?.issues ?? [];

describe('template lint — operations and remainders', () => {
  test('a key/value insert-array-entry is invalid-operation (error) naming the change and the near-miss', async () => {
    const r = await lint();
    const invalid = issuesOf(r, 'reg.add').filter((i) => i.code === 'invalid-operation');
    expect(invalid.length).toBe(1);
    expect(invalid[0]!.severity).toBe('error');
    expect(invalid[0]!.message).toContain('change[0] (insert-array-entry)');
    expect(invalid[0]!.message).toContain('entryValue');
    expect(invalid[0]!.message).toContain('value→entryValue');
    expect(r.results.find((x) => x.templateId === 'reg.add')?.passed).toBe(false);
  });

  test('a CREATE under a new module root with no build config and no declaration → undeclared-remainder (info only)', async () => {
    const r = await lint();
    const info = issuesOf(r, 'mod.new').find((i) => i.code === 'undeclared-remainder');
    expect(info?.severity).toBe('info');
    expect(info?.message).toContain('packages/foo/src');
    expect(r.results.find((x) => x.templateId === 'mod.new')?.passed).toBe(true);
    expect(issuesOf(r, 'mod.declared').some((i) => i.code === 'undeclared-remainder')).toBe(false);
  });

  test('an unknown remainder value or an empty manual step is template-remainder-shape (error)', async () => {
    const r = await lint();
    const shape = issuesOf(r, 'mod.bogus').filter((i) => i.code === 'template-remainder-shape');
    expect(shape.map((i) => i.message)).toEqual([
      expect.stringContaining('unknown remainder "bogus"'),
      expect.stringContaining('manualSteps[0].description'),
    ]);
  });
});

describe('scaffold variable extraction uses the one strategy table', () => {
  test('directoryName.pascal / className.stripSuffix: resolve with no warning', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-r75-scaf-'));
    roots.push(root);
    write(root, 'package.json', JSON.stringify({ name: '@acme/app', version: '0.0.0' }));
    const inspection = await inspectSharkcraft({ cwd: root });
    const r = extractVariablesForFile(
      {
        id: 'p',
        title: 'p',
        description: 'p',
        matchPaths: ['src/**'],
        templateId: 't',
        appliesWhen: ['onboard'],
        confidence: 'high',
        variables: [
          { name: 'feature', from: 'directoryName.pascal' },
          { name: 'featureKebab', from: 'directoryName.kebab' },
          { name: 'entity', from: 'className.stripSuffix:Service' },
          { name: 'file', from: 'filename.stripSuffix:Service' },
        ],
      },
      'src/user-profile/UserProfileService.ts',
      inspection,
    );
    expect(r.warnings).toEqual([]);
    expect(r.values).toEqual({ feature: 'UserProfile', featureKebab: 'user-profile', entity: 'UserProfile', file: 'UserProfile' });
  });
});
