import { describe, expect, test } from 'bun:test';
import {
  safeResolveTargetPath,
  UnsafeTargetPathError,
  containsTraversal,
} from '../index.ts';

const ROOT = '/var/projects/demo';

describe('safeResolveTargetPath', () => {
  test('resolves a relative path under root', () => {
    const result = safeResolveTargetPath('src/services/user.service.ts', ROOT);
    expect(result.absolutePath).toBe('/var/projects/demo/src/services/user.service.ts');
    expect(result.relativePath).toBe('src/services/user.service.ts');
  });

  test('refuses absolute paths by default', () => {
    expect(() => safeResolveTargetPath('/etc/passwd', ROOT)).toThrow(UnsafeTargetPathError);
    try {
      safeResolveTargetPath('/etc/passwd', ROOT);
    } catch (e) {
      expect((e as UnsafeTargetPathError).code).toBe('absolute-path-rejected');
    }
  });

  test('allows absolute paths when opted in', () => {
    const result = safeResolveTargetPath('/var/projects/demo/src/x.ts', ROOT, {
      allowAbsolute: true,
    });
    expect(result.absolutePath).toBe('/var/projects/demo/src/x.ts');
  });

  test('refuses traversal that escapes root', () => {
    expect(() => safeResolveTargetPath('../../../etc/passwd', ROOT)).toThrow(
      UnsafeTargetPathError,
    );
    try {
      safeResolveTargetPath('../../../etc/passwd', ROOT);
    } catch (e) {
      expect((e as UnsafeTargetPathError).code).toBe('outside-project-root');
    }
  });

  test('refuses an empty path', () => {
    expect(() => safeResolveTargetPath('', ROOT)).toThrow(UnsafeTargetPathError);
  });

  test('accepts traversal that stays inside root', () => {
    // src/services/../utils/x.ts → src/utils/x.ts
    const result = safeResolveTargetPath('src/services/../utils/x.ts', ROOT);
    expect(result.relativePath).toBe('src/utils/x.ts');
  });
});

describe('containsTraversal', () => {
  test('detects ../ segments that survive normalization', () => {
    expect(containsTraversal('../foo')).toBe(true);
    expect(containsTraversal('a/../../b')).toBe(true);
  });
  test('returns false for paths that normalize to clean form', () => {
    expect(containsTraversal('src/foo.ts')).toBe(false);
    // a/../b normalizes to "b" — no traversal remains.
    expect(containsTraversal('a/../b')).toBe(false);
  });
});
