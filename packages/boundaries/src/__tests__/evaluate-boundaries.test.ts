import { describe, expect, test } from 'bun:test';
import { defineBoundaryRule, evaluateBoundaries } from '../index.ts';

describe('evaluateBoundaries', () => {
  const rule = defineBoundaryRule({
    id: 'core.no-ui',
    title: 'core may not import ui',
    severity: 'error',
    from: ['libs/core/**'],
    forbiddenImports: ['@scope/ui-*'],
    suggestedFix: 'Move shared contracts into core/common.',
  });

  test('forbidden import in matching file → violation with matchedForbidden', () => {
    const scan = {
      filesScanned: 1,
      edges: [
        { from: 'libs/core/foo.ts', importSpecifier: '@scope/ui-angular', line: 12, kind: 'external' as const },
      ],
      warnings: [],
    };
    const r = evaluateBoundaries(scan, [rule]);
    expect(r.violations.length).toBe(1);
    expect(r.violations[0]!.ruleId).toBe('core.no-ui');
    expect(r.violations[0]!.matchedForbidden).toBe('@scope/ui-*');
    expect(r.violations[0]!.severity).toBe('error');
  });

  test('import in non-matching file → no violation', () => {
    const scan = {
      filesScanned: 1,
      edges: [
        { from: 'libs/ui/foo.ts', importSpecifier: '@scope/ui-angular', line: 5, kind: 'external' as const },
      ],
      warnings: [],
    };
    expect(evaluateBoundaries(scan, [rule]).violations.length).toBe(0);
  });

  test('allowedImports = [X] flags everything else (external only)', () => {
    const allow = defineBoundaryRule({
      id: 'svc.only-core',
      title: 'services may only import core',
      severity: 'warning',
      from: ['src/services/**'],
      allowedImports: ['@scope/core', '@scope/core-*'],
    });
    const scan = {
      filesScanned: 1,
      edges: [
        { from: 'src/services/foo.ts', importSpecifier: '@scope/core-utils', line: 1, kind: 'external' as const },
        { from: 'src/services/foo.ts', importSpecifier: 'lodash', line: 2, kind: 'external' as const },
        { from: 'src/services/foo.ts', importSpecifier: './bar.ts', line: 3, kind: 'internal' as const },
      ],
      warnings: [],
    };
    const r = evaluateBoundaries(scan, [allow]);
    expect(r.violations.length).toBe(1);
    expect(r.violations[0]!.notAllowed).toBe(true);
    expect(r.violations[0]!.importSpecifier).toBe('lodash');
  });

  test('tsconfig alias resolution matches forbiddenImports via resolved candidate', () => {
    const aliasRule = defineBoundaryRule({
      id: 'core.no-ui-via-alias',
      title: 'core may not import ui (even via alias)',
      severity: 'error',
      from: ['libs/core/**'],
      forbiddenImports: ['libs/ui/**'],
    });
    const scan = {
      filesScanned: 1,
      edges: [
        {
          from: 'libs/core/foo.ts',
          importSpecifier: '@scope/ui-angular',
          line: 4,
          kind: 'external' as const,
        },
      ],
      warnings: [],
    };
    const tsconfigPaths = {
      baseUrl: '.',
      aliases: new Map([
        ['@scope/ui-*', ['libs/ui/*/src/index.ts']],
      ]) as ReadonlyMap<string, readonly string[]>,
      sources: [],
    };
    const r = evaluateBoundaries(scan, [aliasRule], { tsconfigPaths });
    expect(r.violations.length).toBe(1);
    expect(r.violations[0]!.matchedForbidden).toBe('libs/ui/**');
    expect(r.violations[0]!.resolvedVia).toBeDefined();
  });

  test('onlyRuleId filter narrows evaluation', () => {
    const a = { ...rule };
    const b = { ...rule, id: 'other.rule' };
    const scan = {
      filesScanned: 1,
      edges: [
        { from: 'libs/core/foo.ts', importSpecifier: '@scope/ui-angular', line: 1, kind: 'external' as const },
      ],
      warnings: [],
    };
    expect(evaluateBoundaries(scan, [a, b], { onlyRuleId: 'other.rule' }).rulesEvaluated).toBe(1);
  });
});
