import { describe, expect, test } from 'bun:test';
import {
  isPathInside,
  joinPath,
  normalizePath,
  toKebabCase,
  toPascalCase,
  toCamelCase,
  toSnakeCase,
} from '../index.ts';

describe('isPathInside', () => {
  test('returns true when child is below parent', () => {
    expect(isPathInside('/proj/src/a.ts', '/proj')).toBe(true);
    expect(isPathInside('/proj/src', '/proj')).toBe(true);
  });

  test('returns false when child equals parent', () => {
    expect(isPathInside('/proj', '/proj')).toBe(false);
  });

  test('returns false for sibling and parent-of-parent paths', () => {
    expect(isPathInside('/other', '/proj')).toBe(false);
    expect(isPathInside('/', '/proj')).toBe(false);
    expect(isPathInside('/proj/../sneaky', '/proj')).toBe(false);
  });
});

describe('case conversions', () => {
  test('toKebabCase', () => {
    expect(toKebabCase('UserProfile')).toBe('user-profile');
    expect(toKebabCase('user_profile_v2')).toBe('user-profile-v2');
    expect(toKebabCase('user profile')).toBe('user-profile');
    expect(toKebabCase('HTTPServer')).toBe('http-server');
  });

  test('toPascalCase', () => {
    expect(toPascalCase('user-profile')).toBe('UserProfile');
    expect(toPascalCase('user_profile')).toBe('UserProfile');
    expect(toPascalCase('user profile')).toBe('UserProfile');
  });

  test('toCamelCase', () => {
    expect(toCamelCase('user-profile')).toBe('userProfile');
    expect(toCamelCase('UserProfile')).toBe('userProfile');
  });

  test('toSnakeCase', () => {
    expect(toSnakeCase('UserProfile')).toBe('user_profile');
    expect(toSnakeCase('user-profile')).toBe('user_profile');
  });
});

describe('path utilities', () => {
  test('joinPath and normalizePath', () => {
    expect(joinPath('a', 'b', 'c.ts')).toBe('a/b/c.ts');
    expect(normalizePath('a/./b/../c')).toBe('a/c');
  });
});
