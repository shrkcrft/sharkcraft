import { describe, expect, test } from 'bun:test';
import { buildWhyReport } from '../why-file.ts';
import type { ISharkcraftInspection } from '../sharkcraft-inspector.ts';

interface IStubRule {
  id: string;
  title: string;
  priority?: string;
  scope?: readonly string[];
  tags?: readonly string[];
  appliesWhen?: readonly string[];
  references?: readonly { kind: string; path?: string; id?: string }[];
}

function inspectionWith(rules: readonly IStubRule[]): ISharkcraftInspection {
  return {
    projectRoot: '/repo',
    pathService: { list: () => [] },
    ruleService: { list: () => rules },
    boundaryRegistry: { list: () => [] },
    boundarySources: new Map(),
    entrySources: new Map(),
    knowledgeEntries: [],
  } as unknown as ISharkcraftInspection;
}

function rulesFor(inspection: ISharkcraftInspection, target: string): readonly { id: string; reason: string }[] {
  return buildWhyReport({ inspection, projectRoot: '/repo', target }).rules.map((r) => ({
    id: r.id,
    reason: r.reason,
  }));
}

describe('why-file rule precision', () => {
  test('a file reference attaches only to that file', () => {
    const insp = inspectionWith([
      { id: 'r1', title: 'R1', references: [{ kind: 'file', path: 'packages/x/src/a.ts' }] },
    ]);
    expect(rulesFor(insp, 'packages/x/src/a.ts').map((r) => r.id)).toEqual(['r1']);
    expect(rulesFor(insp, 'packages/y/src/a.ts')).toEqual([]);
  });

  test('a directory reference attaches to files under it, not siblings', () => {
    const insp = inspectionWith([
      { id: 'rd', title: 'RD', references: [{ kind: 'directory', path: 'packages/x/src' }] },
    ]);
    expect(rulesFor(insp, 'packages/x/src/a.ts').map((r) => r.id)).toEqual(['rd']);
    expect(rulesFor(insp, 'packages/x/test/a.ts')).toEqual([]);
  });

  test('a package reference attaches when the inferred package matches', () => {
    const insp = inspectionWith([
      { id: 'rp', title: 'RP', references: [{ kind: 'package', id: 'packages/x' }] },
    ]);
    expect(rulesFor(insp, 'packages/x/src/a.ts').map((r) => r.id)).toEqual(['rp']);
    expect(rulesFor(insp, 'packages/z/src/a.ts')).toEqual([]);
  });

  test('REGRESSION: topical scope/tags/appliesWhen alone do NOT attach a rule', () => {
    const insp = inspectionWith([
      {
        id: 'topical',
        title: 'Topical',
        scope: ['testing'],
        tags: ['service'],
        appliesWhen: ['generate-code'],
      },
    ]);
    // The old token-intersection matched "service" against user-service.ts etc.
    expect(rulesFor(insp, 'packages/x/src/user-service.ts')).toEqual([]);
  });

  test('a path-glob scope token matches via the boundary glob matcher', () => {
    const insp = inspectionWith([
      { id: 'glob', title: 'Glob', scope: ['packages/x/**/*.ts'] },
    ]);
    expect(rulesFor(insp, 'packages/x/src/a.ts').map((r) => r.id)).toEqual(['glob']);
    expect(rulesFor(insp, 'packages/y/src/a.ts')).toEqual([]);
  });

  test('reasons never use the old "Matches on:" phrasing', () => {
    const insp = inspectionWith([
      { id: 'r1', title: 'R1', references: [{ kind: 'file', path: 'packages/x/src/a.ts' }] },
    ]);
    for (const r of rulesFor(insp, 'packages/x/src/a.ts')) {
      expect(r.reason).not.toContain('Matches on:');
    }
  });
});
