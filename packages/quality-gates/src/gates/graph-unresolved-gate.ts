import { GraphStore } from '@shrkcrft/graph';
import type { IGateResult } from '../schema/quality-gate.ts';

export interface IGraphUnresolvedGateOptions {
  /**
   * When true, any unresolved import fails the gate. Default `false`
   * (warn) — dynamic / runtime-only imports are sometimes intentional.
   */
  failOnAny?: boolean;
}

/**
 * Read the persisted unresolved-import counts from the graph manifest
 * and surface them. Warn by default (since some unresolved specifiers
 * are intentional — dynamic imports, optional peer deps); fail when
 * `failOnAny` is true.
 */
export function graphUnresolvedGate(
  projectRoot: string,
  options: IGraphUnresolvedGateOptions = {},
): IGateResult {
  const start = Date.now();
  const failOnAny = options.failOnAny ?? false;
  const store = new GraphStore(projectRoot);
  if (!store.exists()) {
    return {
      id: 'graph-unresolved',
      label: 'Graph unresolved imports',
      status: 'skipped',
      message: 'Skipped — graph index missing.',
      nextCommands: ['shrk graph index'],
      durationMs: Date.now() - start,
    };
  }
  const snap = store.loadSnapshot();
  const count = snap.manifest.unresolvedImportCount ?? 0;
  const files = snap.manifest.filesWithUnresolvedImports ?? 0;
  const samples = snap.manifest.unresolvedImportSamples ?? [];
  if (count === 0) {
    return {
      id: 'graph-unresolved',
      label: 'Graph unresolved imports',
      status: 'pass',
      message: 'No unresolved imports.',
      durationMs: Date.now() - start,
    };
  }
  return {
    id: 'graph-unresolved',
    label: 'Graph unresolved imports',
    status: failOnAny ? 'fail' : 'warn',
    message: `${count} unresolved import(s) across ${files} file(s).`,
    details: { count, files, samples },
    nextCommands: ['shrk graph unresolved'],
    durationMs: Date.now() - start,
  };
}
