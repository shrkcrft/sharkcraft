import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSearch } from '../engine/run-search.ts';
import type { StructuralPattern } from '../schema/pattern.ts';

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-ss-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'a.ts'),
    [
      "import { foo } from './foo';",
      "import sideEffect from 'side-effect-mod';",
      "function bar() {",
      "  console.log('hi');",
      "  return foo();",
      "}",
      "class IBadName {}",
      "class Controller {}",
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'src', 'b.ts'),
    [
      "function Controller() { return null; }",
      "@Controller() class CtrlA {}",
      "@Module class CtrlB {}",
      "new Map();",
    ].join('\n'),
  );
  return root;
}

describe('runSearch', () => {
  test('finds CallExpression by callee name', () => {
    const root = fixture();
    try {
      const pattern: StructuralPattern = {
        kind: 'CallExpression',
        callee: { kind: 'Identifier', name: 'foo' },
      };
      const r = runSearch({ projectRoot: root, pattern });
      expect(r.matchCount).toBeGreaterThanOrEqual(1);
      expect(r.matches.some((m) => m.file === 'src/a.ts')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('finds CallExpression for property-access callee (console.log)', () => {
    const root = fixture();
    try {
      const pattern: StructuralPattern = {
        kind: 'CallExpression',
        callee: { kind: 'Identifier', name: 'log' },
      };
      const r = runSearch({ projectRoot: root, pattern });
      expect(r.matches.some((m) => m.file === 'src/a.ts' && m.excerpt.includes('console.log'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('finds ImportDeclaration by from regex', () => {
    const root = fixture();
    try {
      const pattern: StructuralPattern = {
        kind: 'ImportDeclaration',
        fromRegex: 'side',
      };
      const r = runSearch({ projectRoot: root, pattern });
      expect(r.matchCount).toBe(1);
      expect(r.matches[0]?.excerpt).toContain('side-effect-mod');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('finds ClassDeclaration by name regex (anti-pattern: I-prefixed classes)', () => {
    const root = fixture();
    try {
      const pattern: StructuralPattern = {
        kind: 'ClassDeclaration',
        nameRegex: '^I[A-Z]',
      };
      const r = runSearch({ projectRoot: root, pattern });
      expect(r.matches.some((m) => m.excerpt.includes('IBadName'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('finds Decorator by name (both @Foo and @Foo())', () => {
    const root = fixture();
    try {
      const pattern: StructuralPattern = { kind: 'Decorator', name: 'Controller' };
      const r = runSearch({ projectRoot: root, pattern });
      expect(r.matches.some((m) => m.excerpt.includes('@Controller'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('NewExpression by callee name', () => {
    const root = fixture();
    try {
      const pattern: StructuralPattern = {
        kind: 'NewExpression',
        callee: { kind: 'Identifier', name: 'Map' },
      };
      const r = runSearch({ projectRoot: root, pattern });
      expect(r.matchCount).toBe(1);
      expect(r.matches[0]?.file).toBe('src/b.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('respects --limit / truncated flag', () => {
    const root = fixture();
    try {
      const pattern: StructuralPattern = { kind: 'Identifier' };
      const r = runSearch({ projectRoot: root, pattern, limit: 5 });
      expect(r.matchCount).toBeLessThanOrEqual(5);
      expect(r.truncated).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
