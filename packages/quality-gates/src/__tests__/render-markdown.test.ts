import { describe, expect, test } from 'bun:test';
import { renderGateReportMarkdown } from '../runner/render-markdown.ts';
import {
  QUALITY_GATE_SCHEMA,
  type IQualityGateReport,
} from '../schema/quality-gate.ts';

function report(over: Partial<IQualityGateReport> = {}): IQualityGateReport {
  return {
    schema: QUALITY_GATE_SCHEMA,
    overall: 'pass',
    startedAt: '2026-05-22T12:00:00Z',
    totalDurationMs: 250,
    counts: { pass: 3, warn: 0, fail: 0, skipped: 0 },
    gates: [
      {
        id: 'graph-fresh',
        label: 'Code graph indexed',
        status: 'pass',
        message: 'Code-graph index is fresh.',
        durationMs: 12,
      },
      {
        id: 'arch',
        label: 'Architecture',
        status: 'pass',
        message: '0 architecture violations.',
        durationMs: 42,
      },
      {
        id: 'impact',
        label: 'Impact (since main)',
        status: 'pass',
        message: 'Risk: low. Looks safe.',
        durationMs: 18,
      },
    ],
    diagnostics: [],
    ...over,
  };
}

describe('renderGateReportMarkdown', () => {
  test('renders pass status with badge + counts + per-gate sections', () => {
    const md = renderGateReportMarkdown(report());
    expect(md).toContain('# SharkCraft quality gates: ✅ PASS');
    expect(md).toContain('| 3 | 0 | 0 | 0 |');
    expect(md).toContain('### ✅ `graph-fresh` — Code graph indexed');
    expect(md).toContain('Risk: low. Looks safe.');
  });

  test('renders fail status + next-step code block', () => {
    const md = renderGateReportMarkdown(
      report({
        overall: 'fail',
        counts: { pass: 0, warn: 0, fail: 1, skipped: 0 },
        gates: [
          {
            id: 'graph-fresh',
            label: 'Code graph indexed',
            status: 'fail',
            message: 'Code-graph store missing.',
            nextCommands: ['shrk graph index'],
            durationMs: 0,
          },
        ],
      }),
    );
    expect(md).toContain('❌ FAIL');
    expect(md).toContain('### ❌ `graph-fresh`');
    expect(md).toContain('```bash');
    expect(md).toContain('shrk graph index');
  });

  test('zero-gates case renders an explicit empty note', () => {
    const md = renderGateReportMarkdown(
      report({
        gates: [],
        counts: { pass: 0, warn: 0, fail: 0, skipped: 0 },
      }),
    );
    expect(md).toContain('(no gates ran)');
  });

  test('renders diagnostics section when non-empty', () => {
    const md = renderGateReportMarkdown(
      report({
        diagnostics: ['repo not in a git tree — gate diff disabled'],
      }),
    );
    expect(md).toContain('## Diagnostics');
    expect(md).toContain('repo not in a git tree');
  });

  test('output ends with a newline so concatenation works', () => {
    const md = renderGateReportMarkdown(report());
    expect(md.endsWith('\n')).toBe(true);
  });
});
