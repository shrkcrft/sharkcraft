import { describe, expect, test } from 'bun:test';
import {
  defineScaffoldPattern,
  isRecognizedScaffoldStrategy,
} from '@shrkcrft/plugin-api';
import { globToRegExp, matchScaffoldPattern } from '../scaffold-patterns.ts';

describe('scaffold-pattern model', () => {
  test('defineScaffoldPattern returns the input unchanged', () => {
    const p = defineScaffoldPattern({
      id: 'x',
      title: 't',
      description: 'd',
      matchPaths: ['src/**/*.ts'],
      templateId: 'tpl',
      variables: [{ name: 'name', from: 'filename.kebab' }],
      appliesWhen: ['onboard'],
      confidence: 'high',
    });
    expect(p.id).toBe('x');
  });

  test('recognized strategies include className.stripPrefix:I', () => {
    expect(isRecognizedScaffoldStrategy('filename.kebab')).toBe(true);
    expect(isRecognizedScaffoldStrategy('className.stripPrefix:I')).toBe(true);
    expect(isRecognizedScaffoldStrategy('totally-made-up')).toBe(false);
  });

  test('glob-to-regex matches recursive **', () => {
    const re = globToRegExp('libs/**/contracts/**/*.ts');
    expect(re.test('libs/demo/plugin/plugin-api/src/lib/contracts/user.ts')).toBe(true);
    expect(re.test('libs/demo/plugin/plugin-api/src/lib/other/user.ts')).toBe(false);
  });

  test('matchScaffoldPattern honors excludePaths', () => {
    const p = {
      id: 'x',
      title: 't',
      description: 'd',
      matchPaths: ['libs/**/*.ts'],
      excludePaths: ['libs/**/*.spec.ts'],
      templateId: 'tpl',
      variables: [],
      appliesWhen: ['onboard'],
      confidence: 'high' as const,
    };
    expect(matchScaffoldPattern(p, 'libs/foo/bar.ts')).toBe(true);
    expect(matchScaffoldPattern(p, 'libs/foo/bar.spec.ts')).toBe(false);
  });
});
