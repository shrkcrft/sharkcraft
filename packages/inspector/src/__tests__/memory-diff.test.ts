import { describe, expect, it } from 'bun:test';
import {
  diffMemoryIndex,
  MemoryRiskTrend,
  REPO_MEMORY_SCHEMA,
  type IRepositoryMemoryIndex,
} from '../index.ts';

function makeIndex(overrides: Partial<IRepositoryMemoryIndex>): IRepositoryMemoryIndex {
  const base: IRepositoryMemoryIndex = {
    schema: REPO_MEMORY_SCHEMA,
    generatedAt: new Date().toISOString(),
    projectRoot: '/fake',
    sourceCount: 1,
    scannedDirs: [],
    files: [],
    diagnostics: [],
    plansWithConflicts: [],
    boundaryViolationsRecurring: [],
    policyViolationsRecurring: [],
    releaseBlockers: [],
    packIssues: [],
    failedValidationCommands: [],
    slowValidationCommands: [],
    recentTaskTypes: [],
    playbooks: [],
    highRiskConstructs: [],
    warnings: [],
    notes: [],
  };
  return { ...base, ...overrides };
}

describe('memory diff', () => {
  it('flags new risky files when previous snapshot is null', () => {
    const after = makeIndex({
      files: [{ path: 'src/foo.ts', touchCount: 5, conflictCount: 1, failedValidationCount: 0, warningCount: 0 }],
    });
    const diff = diffMemoryIndex(null, after);
    expect(diff.hasPrevious).toBe(false);
    expect(diff.riskTrend).toBe(MemoryRiskTrend.Unknown);
    expect(diff.newRiskyFiles).toHaveLength(1);
  });

  it('detects new risky file between snapshots', () => {
    const before = makeIndex({
      files: [{ path: 'src/foo.ts', touchCount: 5, conflictCount: 0, failedValidationCount: 0, warningCount: 0 }],
    });
    const after = makeIndex({
      files: [
        { path: 'src/foo.ts', touchCount: 5, conflictCount: 0, failedValidationCount: 0, warningCount: 0 },
        { path: 'src/bar.ts', touchCount: 3, conflictCount: 1, failedValidationCount: 0, warningCount: 0 },
      ],
    });
    const diff = diffMemoryIndex(before, after);
    expect(diff.hasPrevious).toBe(true);
    expect(diff.newRiskyFiles.find((f) => f.path === 'src/bar.ts')).toBeDefined();
  });

  it('detects resolved risky file', () => {
    const before = makeIndex({
      files: [
        { path: 'src/foo.ts', touchCount: 5, conflictCount: 0, failedValidationCount: 0, warningCount: 0 },
        { path: 'src/bar.ts', touchCount: 3, conflictCount: 1, failedValidationCount: 0, warningCount: 0 },
      ],
    });
    const after = makeIndex({
      files: [{ path: 'src/foo.ts', touchCount: 5, conflictCount: 0, failedValidationCount: 0, warningCount: 0 }],
    });
    const diff = diffMemoryIndex(before, after);
    expect(diff.resolvedRiskyFiles.find((f) => f.path === 'src/bar.ts')).toBeDefined();
  });

  it('worsening trend when many new risks + new diagnostics', () => {
    const before = makeIndex({ files: [] });
    const after = makeIndex({
      files: [
        { path: 'a', touchCount: 5, conflictCount: 1, failedValidationCount: 0, warningCount: 0 },
        { path: 'b', touchCount: 5, conflictCount: 0, failedValidationCount: 1, warningCount: 0 },
        { path: 'c', touchCount: 5, conflictCount: 0, failedValidationCount: 0, warningCount: 1 },
      ],
      diagnostics: [
        { code: 'plan-failed', count: 3 },
        { code: 'boundary-violation', count: 2 },
      ],
      plansWithConflicts: ['p1', 'p2'],
    });
    const diff = diffMemoryIndex(before, after);
    expect(diff.riskTrend).toBe(MemoryRiskTrend.Worsening);
  });

  it('stable trend when nothing changes', () => {
    const idx = makeIndex({
      files: [{ path: 'a', touchCount: 5, conflictCount: 0, failedValidationCount: 0, warningCount: 0 }],
    });
    const diff = diffMemoryIndex(idx, idx);
    expect(diff.riskTrend).toBe(MemoryRiskTrend.Stable);
  });
});
