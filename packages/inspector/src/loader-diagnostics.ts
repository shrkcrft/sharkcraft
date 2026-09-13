import type { IRejectedEntry } from '@shrkcrft/core';
import type { LoaderAssetKind, LoaderAssetStatus } from './inspector-cache.ts';

export type LoaderOrigin = 'local-config' | 'pack-manifest';

export interface ILoaderDiagnostic {
  filePath: string;
  kind: LoaderAssetKind;
  origin: LoaderOrigin;
  packName?: string;
  elapsedMs: number;
  /**
   * `missing` — a file the local config DECLARES (e.g. `knowledgeFiles`) does
   * not exist, so nothing was loaded from it. Recorded so a corpus check can
   * refuse to pass over a source it was told about and never read.
   */
  status: LoaderAssetStatus | 'cached-skip' | 'missing';
  /** Number of items extracted (entries/templates/etc) — the loader's ACCEPTED count. */
  count: number;
  /**
   * Entries the file declared that the loader refused (round 12, 12.1), so
   * `count + rejected.length === declared`. Absent when none were refused.
   * Lifted into THE rejection channel by `collectContributionRejections`.
   */
  rejected?: readonly IRejectedEntry[];
  warningCount: number;
  errorMessage?: string;
  /** When status === 'cached-skip', this is the cached pre-existing status. */
  cachedStatus?: LoaderAssetStatus;
  /** Whether this load hit the in-memory import dedup. */
  deduped: boolean;
  /** Whether the file exceeded the large-file threshold. */
  largeFile: boolean;
  /** File size in bytes, when known. */
  sizeBytes?: number;
  /** Whether the elapsed time crossed the slow threshold. */
  slow: boolean;
  /** Suggested next command for the user to debug this. */
  suggestedNextCommand?: string;
}

export const DEFAULT_SLOW_LOADER_THRESHOLD_MS = 1500;
export const LARGE_FILE_THRESHOLD_BYTES = 256 * 1024;

export function formatLoaderDiagnosticLine(d: ILoaderDiagnostic): string {
  const flags: string[] = [];
  if (d.deduped) flags.push('deduped');
  if (d.largeFile) flags.push('large');
  if (d.slow) flags.push('slow');
  if (d.status === 'cached-skip') flags.push(`cached:${d.cachedStatus ?? 'n/a'}`);
  const flagStr = flags.length ? ` [${flags.join(', ')}]` : '';
  return `  ${d.kind.padEnd(10)} ${d.status.padEnd(12)} ${d.elapsedMs.toString().padStart(5)}ms  count=${d.count}${flagStr}  ${d.filePath}`;
}

export function summarizeLoaderDiagnostics(diagnostics: readonly ILoaderDiagnostic[]): {
  totalLoaders: number;
  totalElapsedMs: number;
  failed: number;
  timedOut: number;
  cachedSkips: number;
  deduped: number;
  largeFiles: number;
  slowLoaders: number;
} {
  let totalElapsedMs = 0;
  let failed = 0;
  let timedOut = 0;
  let cachedSkips = 0;
  let deduped = 0;
  let largeFiles = 0;
  let slowLoaders = 0;
  for (const d of diagnostics) {
    totalElapsedMs += d.elapsedMs;
    if (d.status === 'failed') failed += 1;
    else if (d.status === 'timeout') timedOut += 1;
    else if (d.status === 'cached-skip') cachedSkips += 1;
    if (d.deduped) deduped += 1;
    if (d.largeFile) largeFiles += 1;
    if (d.slow) slowLoaders += 1;
  }
  return {
    totalLoaders: diagnostics.length,
    totalElapsedMs,
    failed,
    timedOut,
    cachedSkips,
    deduped,
    largeFiles,
    slowLoaders,
  };
}
