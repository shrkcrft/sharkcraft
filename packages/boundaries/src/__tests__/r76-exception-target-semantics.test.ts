/**
 * Round 12 (R12-5.4) — `exceptions[].target` takes the rule's forbidden-pattern
 * semantics, by DECISION.
 *
 * Under the default package semantics a bare target also excuses the target's
 * subpaths: an exception allows one (path, target) PAIR, which may be more than
 * one edge. That keeps a target spelled like the forbidden pattern excusing
 * exactly what that pattern flags (the docs' `target: '@acme/legacy-sdk'`
 * bridge keeps covering `@acme/legacy-sdk/client`). `forbiddenMatch: 'exact'`
 * makes targets exact too. This file pins both so the next round cannot flip
 * either silently. Real files, a real scan.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { evaluateBoundaries, scanImports, type IBoundaryRule } from '../index.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function scanOf(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r76-exception-'));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return scanImports({ projectRoot: root });
}

const B_TS = [
  "import { t } from '@scope/pkg/testing';",
  "import { d } from '@scope/pkg/testing/internal/deep';",
  "import { o } from '@scope/pkg/other';",
].join('\n');

const rule = (over: Partial<IBoundaryRule>): IBoundaryRule => ({
  id: 'b.exception-widening',
  title: 'No pkg',
  severity: 'error',
  from: ['packages/b/**'],
  exceptions: [{ path: 'packages/b/**', target: '@scope/pkg/testing', reason: 'test helpers are sanctioned' }],
  ...over,
});

describe('exception targets follow the rule\'s forbiddenMatch', () => {
  test('default (package): a bare target excuses the deeper subpath too, and is credited for both edges — not stale', () => {
    const r = evaluateBoundaries(scanOf({ 'packages/b/src/b.ts': B_TS }), [rule({ forbiddenImports: ['@scope/pkg'] })]);
    expect(r.suppressed.map((s) => [s.violation.importSpecifier, s.reason])).toEqual([
      ['@scope/pkg/testing', 'exception'],
      ['@scope/pkg/testing/internal/deep', 'exception'],
    ]);
    expect(r.violations.map((v) => v.importSpecifier)).toEqual(['@scope/pkg/other']);
    expect(r.coverage[0]!.exceptions.map((e) => e.matched)).toEqual([2]);
    expect(r.staleExceptions).toEqual([]);
  });

  test("forbiddenMatch 'exact': the same exception excuses ONLY the literal target; the deeper import is an unsuppressed violation", () => {
    const r = evaluateBoundaries(scanOf({ 'packages/b/src/b.ts': B_TS }), [
      rule({ forbiddenImports: ['@scope/pkg', '@scope/pkg/**'], forbiddenMatch: 'exact' }),
    ]);
    expect(r.suppressed.map((s) => s.violation.importSpecifier)).toEqual(['@scope/pkg/testing']);
    expect(r.violations.map((v) => v.importSpecifier)).toEqual(['@scope/pkg/testing/internal/deep', '@scope/pkg/other']);
    expect(r.coverage[0]!.exceptions.map((e) => e.matched)).toEqual([1]);
    expect(r.staleExceptions).toEqual([]);
  });

  test("the docs' bridge example: target '@acme/legacy-sdk' keeps covering '@acme/legacy-sdk/client' on the bridge file only", () => {
    const r = evaluateBoundaries(
      scanOf({
        'src/app/bridge.ts': "import { c } from '@acme/legacy-sdk/client';\n",
        'src/app/other.ts': "import { c } from '@acme/legacy-sdk/client';\n",
      }),
      [
        {
          id: 'app.no-legacy-sdk',
          title: 'No legacy SDK',
          from: ['src/app/**'],
          forbiddenImports: ['@acme/legacy-sdk'],
          exceptions: [{ path: 'src/app/bridge.ts', target: '@acme/legacy-sdk', reason: 'ADR-12: the one sanctioned bridge' }],
        },
      ],
    );
    expect(r.suppressed.map((s) => [s.violation.file, s.reason])).toEqual([['src/app/bridge.ts', 'exception']]);
    expect(r.violations.map((v) => [v.file, v.matchKind])).toEqual([['src/app/other.ts', 'subpath']]);
  });
});
