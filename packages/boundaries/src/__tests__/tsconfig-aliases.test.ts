import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadTsconfigPaths,
  resolveAliasCandidates,
} from '../scan/tsconfig-aliases.ts';

describe('tsconfig path aliases', () => {
  test('loads tsconfig.base.json and exposes its paths map', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-tsconfig-'));
    try {
      writeFileSync(
        join(root, 'tsconfig.base.json'),
        JSON.stringify({
          compilerOptions: {
            baseUrl: '.',
            paths: {
              '@scope/core': ['packages/core/src/index.ts'],
              '@scope/*': ['packages/*/src/index.ts'],
            },
          },
        }),
        'utf8',
      );
      const m = loadTsconfigPaths(root);
      expect(m.sources.length).toBe(1);
      expect(m.aliases.get('@scope/core')).toEqual([
        'packages/core/src/index.ts',
      ]);
      expect(m.aliases.get('@scope/*')).toEqual(['packages/*/src/index.ts']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('tolerates comments and trailing commas in tsconfig.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-tsconfig-'));
    try {
      writeFileSync(
        join(root, 'tsconfig.json'),
        [
          '{',
          '  // tsconfig with comments',
          '  "compilerOptions": {',
          '    "baseUrl": ".",',
          '    "paths": {',
          '      "@scope/x": ["packages/x/src/index.ts"], /* trailing */',
          '    },',
          '  },',
          '}',
        ].join('\n'),
        'utf8',
      );
      const m = loadTsconfigPaths(root);
      expect(m.aliases.get('@scope/x')).toEqual([
        'packages/x/src/index.ts',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('exact alias resolves to its declared target', () => {
    const m = loadTsconfigPathsInline({
      '@scope/core': ['packages/core/src/index.ts'],
    });
    expect(resolveAliasCandidates('@scope/core', m)).toEqual([
      'packages/core/src/index.ts',
    ]);
  });

  test('wildcard alias substitutes the suffix into each target', () => {
    const m = loadTsconfigPathsInline({
      '@scope/*': ['packages/*/src/index.ts'],
    });
    expect(resolveAliasCandidates('@scope/foo', m)).toEqual([
      'packages/foo/src/index.ts',
    ]);
    expect(resolveAliasCandidates('@scope/foo/bar', m)).toEqual([
      'packages/foo/bar/src/index.ts',
    ]);
  });

  test('unmatched specifier returns []', () => {
    const m = loadTsconfigPathsInline({
      '@scope/*': ['packages/*/src/index.ts'],
    });
    expect(resolveAliasCandidates('lodash', m)).toEqual([]);
    expect(resolveAliasCandidates('@other/foo', m)).toEqual([]);
  });
});

function loadTsconfigPathsInline(paths: Record<string, string[]>) {
  const root = mkdtempSync(join(tmpdir(), 'shrk-tsconfig-inline-'));
  writeFileSync(
    join(root, 'tsconfig.base.json'),
    JSON.stringify({ compilerOptions: { baseUrl: '.', paths } }),
    'utf8',
  );
  try {
    return loadTsconfigPaths(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
