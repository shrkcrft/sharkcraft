import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { IQualityGateReport } from '../schema/quality-gate.ts';

const REPORT_REL = '.sharkcraft/quality-gates/last.json';

/**
 * Persist + load the most recent quality-gate report for a project.
 *
 * The dashboard's `/api/quality-gates` endpoint prefers a recent saved
 * report over running the gates fresh on every page load. The CLI's
 * `shrk gate` writes here after each run so the two paths agree.
 */
export class QualityGateReportStore {
  public readonly absPath: string;

  constructor(private readonly projectRoot: string) {
    this.absPath = nodePath.join(projectRoot, REPORT_REL);
  }

  exists(): boolean {
    return existsSync(this.absPath);
  }

  read(): IQualityGateReport | undefined {
    if (!this.exists()) return undefined;
    try {
      return JSON.parse(readFileSync(this.absPath, 'utf8')) as IQualityGateReport;
    } catch {
      return undefined;
    }
  }

  write(report: IQualityGateReport): void {
    mkdirSync(nodePath.dirname(this.absPath), { recursive: true });
    writeFileSync(this.absPath, JSON.stringify(report, null, 2), 'utf8');
  }

  /** Age of the saved report in milliseconds, or `undefined` when missing. */
  ageMs(): number | undefined {
    const r = this.read();
    if (!r) return undefined;
    const t = Date.parse(r.startedAt);
    if (Number.isNaN(t)) return undefined;
    return Date.now() - t;
  }
}
