import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateBoundaryRule } from '../model/boundary-rule.ts';
import { loadBoundaryRulesFromFile } from '../registry/load-boundary-rules.ts';

// --- validateBoundaryRule (unit) --------------------------------------------

describe('validateBoundaryRule', () => {
  const validRule = {
    id: 'no-core-up',
    title: 'core must not import cli',
    from: ['packages/core/**'],
    forbiddenImports: ['@shrkcrft/cli'],
  };

  test('accepts a well-formed rule', () => {
    const r = validateBoundaryRule(validRule);
    expect(r.valid).toBe(true);
    expect(r.issues).toEqual([]);
  });

  test('rejects a non-object value', () => {
    for (const bad of [null, undefined, 42, 'rule']) {
      const r = validateBoundaryRule(bad);
      expect(r.valid).toBe(false);
      expect(r.issues.map((i) => i.field)).toContain('<root>');
    }
  });

  test('rejects a non-slug id', () => {
    const r = validateBoundaryRule({ ...validRule, id: 'Bad Id' });
    expect(r.valid).toBe(false);
    expect(r.issues.map((i) => i.field)).toContain('id');
  });

  test('rejects an empty title', () => {
    const r = validateBoundaryRule({ ...validRule, title: '' });
    expect(r.valid).toBe(false);
    expect(r.issues.map((i) => i.field)).toContain('title');
  });

  test('rejects an empty or missing from list', () => {
    const empty = validateBoundaryRule({ ...validRule, from: [] });
    expect(empty.valid).toBe(false);
    expect(empty.issues.map((i) => i.field)).toContain('from');

    const { from: _omit, ...noFrom } = validRule;
    const missing = validateBoundaryRule(noFrom);
    expect(missing.valid).toBe(false);
    expect(missing.issues.map((i) => i.field)).toContain('from');
  });

  test('rejects a rule with neither forbiddenImports nor allowedImports', () => {
    const { forbiddenImports: _omit, ...neither } = validRule;
    const r = validateBoundaryRule(neither);
    expect(r.valid).toBe(false);
    expect(r.issues.map((i) => i.field)).toContain('forbiddenImports|allowedImports');
  });

  test('allowedImports alone satisfies the import-list requirement', () => {
    const { forbiddenImports: _omit, ...allowed } = validRule;
    const r = validateBoundaryRule({ ...allowed, allowedImports: ['@shrkcrft/core'] });
    expect(r.valid).toBe(true);
  });
});

// --- loadBoundaryRulesFromFile ----------------------------------------------

const createdDirs: string[] = [];
function writeModule(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'shrk-boundary-load-'));
  createdDirs.push(dir);
  const file = join(dir, name);
  writeFileSync(file, body);
  return file;
}

afterAll(() => {
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
});

const ruleLiteral = (id: string) =>
  `{ id: '${id}', title: '${id} title', from: ['packages/${id}/**'], forbiddenImports: ['@shrkcrft/cli'] }`;

describe('loadBoundaryRulesFromFile', () => {
  test('a missing file yields a not-found warning and no rules', async () => {
    const missing = join(tmpdir(), `shrk-boundary-missing-${Date.now()}`, 'boundaries.ts');
    const res = await loadBoundaryRulesFromFile(missing);
    expect(res.rules).toEqual([]);
    expect(res.warnings.some((w) => w.includes('not found'))).toBe(true);
  });

  test('loads rules from a default-exported array', async () => {
    const file = writeModule('default.ts', `export default [${ruleLiteral('alpha')}];\n`);
    const res = await loadBoundaryRulesFromFile(file);
    expect(res.rules.map((r) => r.id)).toEqual(['alpha']);
    expect(res.warnings).toEqual([]);
  });

  test('loads rules from a `rules` named export', async () => {
    const file = writeModule('rules.ts', `export const rules = [${ruleLiteral('beta')}];\n`);
    const res = await loadBoundaryRulesFromFile(file);
    expect(res.rules.map((r) => r.id)).toEqual(['beta']);
  });

  test('loads rules from a `boundaries` named export', async () => {
    const file = writeModule(
      'boundaries.ts',
      `export const boundaries = [${ruleLiteral('gamma')}];\n`,
    );
    const res = await loadBoundaryRulesFromFile(file);
    expect(res.rules.map((r) => r.id)).toEqual(['gamma']);
  });

  test('drops a malformed rule and warns naming the offending field', async () => {
    const file = writeModule(
      'mixed.ts',
      `export default [
        ${ruleLiteral('good')},
        { id: 'bad', title: 'Bad', from: [], forbiddenImports: ['x'] },
      ];\n`,
    );
    const res = await loadBoundaryRulesFromFile(file);
    expect(res.rules.map((r) => r.id)).toEqual(['good']);
    expect(
      res.warnings.some((w) => w.includes('skipping invalid boundary rule') && w.includes('from')),
    ).toBe(true);
  });
});
