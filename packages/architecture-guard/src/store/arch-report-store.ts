import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import type {
  ArchViolationSeverity,
  IArchReport,
  IArchViolation,
} from '../schema/violation.ts';

export const ARCH_SNAPSHOT_SCHEMA = 'sharkcraft.architecture-snapshot/v1' as const;
const DIR = '.sharkcraft/architecture';
const LAST_FILE = 'last.json';
const BASELINE_FILE = 'baseline.json';

/**
 * Compact, comparison-friendly snapshot of an `IArchReport`. The full
 * report can grow to hundreds of violations on a large repo — we don't
 * need to persist every field for delta computation. The snapshot
 * keeps counts + a deterministically-hashable violation id list so
 * `shrk doctor` can answer "did anything new appear since the baseline?"
 * without re-running the full check.
 */
export interface IArchSnapshot {
  schema: typeof ARCH_SNAPSHOT_SCHEMA;
  generatedAt: string;
  filesAnalyzed: number;
  countsBySeverity: Readonly<Record<ArchViolationSeverity, number>>;
  countsByKind: Readonly<Record<string, number>>;
  /**
   * Stable, sorted set of violation ids in the form
   * `<kind>|<file>[:line]|<targetFile?>`. Used for delta computation.
   * A violation appearing in `last` but not in `baseline` counts as
   * "new"; a violation in `baseline` but not in `last` counts as "fixed".
   */
  violationIds: readonly string[];
}

export function snapshotFromReport(report: IArchReport): IArchSnapshot {
  const ids = new Set<string>();
  for (const v of report.violations) ids.add(violationId(v));
  return {
    schema: ARCH_SNAPSHOT_SCHEMA,
    generatedAt: new Date().toISOString(),
    filesAnalyzed: report.filesAnalyzed,
    countsBySeverity: { ...report.countsBySeverity },
    countsByKind: { ...report.countsByKind },
    violationIds: [...ids].sort(),
  };
}

export function violationId(v: IArchViolation): string {
  const filePart = v.line ? `${v.file}:${v.line}` : v.file;
  const target = v.targetFile ? `|${v.targetFile}` : '';
  return `${v.kind}|${filePart}${target}`;
}

export class ArchReportStore {
  public readonly lastPath: string;
  public readonly baselinePath: string;

  constructor(private readonly projectRoot: string) {
    this.lastPath = nodePath.join(projectRoot, DIR, LAST_FILE);
    this.baselinePath = nodePath.join(projectRoot, DIR, BASELINE_FILE);
  }

  writeLast(report: IArchReport): IArchSnapshot {
    const snap = snapshotFromReport(report);
    this.write(this.lastPath, snap);
    return snap;
  }

  writeBaseline(report: IArchReport): IArchSnapshot {
    const snap = snapshotFromReport(report);
    this.write(this.baselinePath, snap);
    return snap;
  }

  readLast(): IArchSnapshot | undefined {
    return this.read(this.lastPath);
  }

  readBaseline(): IArchSnapshot | undefined {
    return this.read(this.baselinePath);
  }

  clearBaseline(): boolean {
    if (existsSync(this.baselinePath)) {
      rmSync(this.baselinePath);
      return true;
    }
    return false;
  }

  private write(absPath: string, snap: IArchSnapshot): void {
    mkdirSync(nodePath.dirname(absPath), { recursive: true });
    writeFileSync(absPath, JSON.stringify(snap, null, 2), 'utf8');
  }

  private read(absPath: string): IArchSnapshot | undefined {
    if (!existsSync(absPath)) return undefined;
    try {
      const raw = JSON.parse(readFileSync(absPath, 'utf8')) as IArchSnapshot;
      if (raw.schema !== ARCH_SNAPSHOT_SCHEMA) return undefined;
      return raw;
    } catch {
      return undefined;
    }
  }
}

export interface IArchSnapshotDelta {
  /** Violation ids present in `last` but not `baseline`. */
  newViolationIds: readonly string[];
  /** Violation ids present in `baseline` but not `last`. */
  fixedViolationIds: readonly string[];
  /** Net change in error count (last − baseline). */
  errorDelta: number;
  /** Net change in warning count (last − baseline). */
  warningDelta: number;
}

export function diffSnapshots(
  baseline: IArchSnapshot,
  last: IArchSnapshot,
): IArchSnapshotDelta {
  const baseSet = new Set(baseline.violationIds);
  const lastSet = new Set(last.violationIds);
  const newViolationIds = last.violationIds.filter((id) => !baseSet.has(id));
  const fixedViolationIds = baseline.violationIds.filter((id) => !lastSet.has(id));
  return {
    newViolationIds,
    fixedViolationIds,
    errorDelta: last.countsBySeverity.error - baseline.countsBySeverity.error,
    warningDelta: last.countsBySeverity.warning - baseline.countsBySeverity.warning,
  };
}
