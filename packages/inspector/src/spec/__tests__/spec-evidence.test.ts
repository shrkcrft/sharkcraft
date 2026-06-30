import { describe, expect, it } from 'bun:test';
import {
  mapChecklistToEvidence,
  type IChecklistCriterionInput,
} from '../spec-evidence.ts';

describe('mapChecklistToEvidence', () => {
  it('marks exactly the unimplemented criterion UNMET', () => {
    const criteria: IChecklistCriterionInput[] = [
      { id: 'ac-1', text: 'Add a coverage flag to spec verify' },
      { id: 'ac-2', text: 'Export a telemetry dashboard widget' },
    ];
    // The changeset implements ac-1 only (coverage), nothing for ac-2.
    const changedFiles = [
      'packages/cli/src/commands/spec.command.ts',
      'packages/inspector/src/spec/__tests__/spec-coverage.test.ts',
    ];
    const fileContents: Record<string, string> = {
      'packages/cli/src/commands/spec.command.ts': [
        'export function specVerifyCoverageReport() {',
        '  return mapChecklistToEvidence();',
        '}',
      ].join('\n'),
      'packages/inspector/src/spec/__tests__/spec-coverage.test.ts': [
        "import { specVerifyCoverageReport } from '../x.ts';",
        "it('reports coverage', () => {});",
      ].join('\n'),
    };

    const report = mapChecklistToEvidence({ criteria, changedFiles, fileContents });

    expect(report.criteria).toHaveLength(2);
    const covered = report.criteria.find((c) => c.id === 'ac-1')!;
    const unmet = report.criteria.find((c) => c.id === 'ac-2')!;

    expect(covered.covered).toBe(true);
    expect(covered.evidence.length).toBeGreaterThan(0);
    // The exported symbol naming the feature is concrete backing evidence.
    expect(covered.evidence.some((e) => e.kind === 'symbol')).toBe(true);

    expect(unmet.covered).toBe(false);
    expect(unmet.evidence).toHaveLength(0);

    expect(report.coveredCount).toBe(1);
    expect(report.unmetCount).toBe(1);
    // Exactly the unimplemented criterion is UNMET.
    expect(report.criteria.filter((c) => !c.covered).map((c) => c.id)).toEqual(['ac-2']);
  });

  it('recognises a new test file as backing evidence', () => {
    const report = mapChecklistToEvidence({
      criteria: [{ id: 'ac-1', text: 'Wire a deterministic compaction pass' }],
      changedFiles: ['packages/compress/src/__tests__/compaction.test.ts'],
      fileContents: {
        'packages/compress/src/__tests__/compaction.test.ts': "it('compacts', () => {});",
      },
    });
    const c = report.criteria[0]!;
    expect(c.covered).toBe(true);
    expect(c.evidence.every((e) => e.kind === 'test')).toBe(true);
    expect(report.unmetCount).toBe(0);
  });

  it('flags a registration / array membership as evidence', () => {
    const report = mapChecklistToEvidence({
      criteria: [{ id: 'ac-1', text: 'Register the telemetry handler' }],
      changedFiles: ['packages/cli/src/registry.ts'],
      fileContents: {
        'packages/cli/src/registry.ts': [
          'const handlerMap = {',
          '  telemetry: telemetryHandler,',
          '};',
        ].join('\n'),
      },
    });
    const c = report.criteria[0]!;
    expect(c.covered).toBe(true);
    expect(c.evidence.some((e) => e.kind === 'registration' || e.kind === 'route')).toBe(true);
  });

  it('reports every criterion UNMET when the changeset is empty', () => {
    const report = mapChecklistToEvidence({
      criteria: [
        { id: 'ac-1', text: 'Add coverage mapping' },
        { id: 'ac-2', text: 'Add telemetry dashboard' },
      ],
      changedFiles: [],
      fileContents: {},
    });
    expect(report.coveredCount).toBe(0);
    expect(report.unmetCount).toBe(2);
  });
});
