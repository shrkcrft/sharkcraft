import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSearch } from '../engine/run-search.ts';
import type { StructuralPattern } from '../schema/pattern.ts';

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-ss-regex-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'a.ts'),
    ["import { foo } from './foo';", 'function bar() { return foo(); }', 'class Controller {}'].join('\n'),
  );
  return root;
}

describe('match-pattern: an invalid user regex is contained, not a crash', () => {
  test('invalid Identifier nameRegex yields no matches instead of throwing', () => {
    const root = fixture();
    try {
      const pattern: StructuralPattern = { kind: 'Identifier', nameRegex: '[' };
      let r: ReturnType<typeof runSearch> | undefined;
      expect(() => {
        r = runSearch({ projectRoot: root, pattern });
      }).not.toThrow();
      expect(r!.matchCount).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('invalid ClassDeclaration nameRegex does not abort the search walk', () => {
    const root = fixture();
    try {
      const pattern: StructuralPattern = { kind: 'ClassDeclaration', nameRegex: '(' };
      expect(() => runSearch({ projectRoot: root, pattern })).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a valid nameRegex still matches (guard preserves valid behavior)', () => {
    const root = fixture();
    try {
      const pattern: StructuralPattern = { kind: 'ClassDeclaration', nameRegex: '^Cont' };
      const r = runSearch({ projectRoot: root, pattern });
      expect(r.matchCount).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
