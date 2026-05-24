import { readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  diffApiSurfaces,
  extractApiSurface,
  type IApiSurface,
} from '@shrkcrft/api-surface-diff';
import { GraphStore } from '@shrkcrft/graph';
import type { IGateResult } from '../schema/quality-gate.ts';

export interface IApiDiffGateOptions {
  /** Path to a saved `IApiSurface` baseline. Required. */
  baselinePath: string;
  /** When true, breaking changes fail the gate. Default true. */
  failOnBreaking?: boolean;
  /** Restrict diff to these packages. */
  packageFilter?: readonly string[];
}

/**
 * API-surface diff gate. Compares the current code-graph's public
 * surface to a saved baseline (typically committed at the last
 * release) and fails when any breaking changes appear.
 *
 * Skipped when:
 *   - the baseline file doesn't exist (use `shrk api-diff capture` to
 *     create one)
 *   - the code-graph isn't indexed
 */
export function apiDiffGate(projectRoot: string, options: IApiDiffGateOptions): IGateResult {
  const start = Date.now();
  const failOnBreaking = options.failOnBreaking ?? true;
  const abs = nodePath.isAbsolute(options.baselinePath)
    ? options.baselinePath
    : nodePath.resolve(projectRoot, options.baselinePath);
  let baseline: IApiSurface;
  try {
    baseline = JSON.parse(readFileSync(abs, 'utf8'));
  } catch (e) {
    return {
      id: 'api-diff',
      label: 'API surface',
      status: 'skipped',
      message: `Baseline read failed: ${(e as Error).message}`,
      nextCommands: ['shrk api-diff capture --output ' + options.baselinePath],
      durationMs: Date.now() - start,
    };
  }
  const store = new GraphStore(projectRoot);
  if (!store.exists()) {
    return {
      id: 'api-diff',
      label: 'API surface',
      status: 'skipped',
      message: 'Skipped — graph index missing.',
      nextCommands: ['shrk graph index'],
      durationMs: Date.now() - start,
    };
  }
  const snap = store.loadSnapshot();
  const current = extractApiSurface(snap, {
    ...(options.packageFilter && options.packageFilter.length > 0
      ? { packageFilter: options.packageFilter }
      : {}),
  });
  const diff = diffApiSurfaces(baseline, current);
  if (failOnBreaking && diff.breakingCount > 0) {
    return {
      id: 'api-diff',
      label: 'API surface',
      status: 'fail',
      message: `${diff.breakingCount} breaking API change(s).`,
      details: {
        added: diff.added,
        removed: diff.removed,
        changed: diff.changed,
        breaking: diff.breakingCount,
      },
      nextCommands: [`shrk api-diff ${options.baselinePath}`],
      durationMs: Date.now() - start,
    };
  }
  if (diff.added > 0 || diff.removed > 0 || diff.changed > 0) {
    return {
      id: 'api-diff',
      label: 'API surface',
      status: diff.breakingCount > 0 ? 'warn' : 'pass',
      message: `${diff.added} added, ${diff.removed} removed, ${diff.changed} changed (no breaking).`,
      details: {
        added: diff.added,
        removed: diff.removed,
        changed: diff.changed,
        breaking: diff.breakingCount,
      },
      durationMs: Date.now() - start,
    };
  }
  return {
    id: 'api-diff',
    label: 'API surface',
    status: 'pass',
    message: 'No API surface changes.',
    durationMs: Date.now() - start,
  };
}
