import { GraphStore } from '@shrkcrft/graph';
import type { IGateResult } from '../schema/quality-gate.ts';

export interface IGraphCyclesGateOptions {
  /** A cycle counts as "large" at or above this size. Default 3. */
  largeCycleSize?: number;
  /** Total cycles at or above this count triggers warn. Default 5. */
  manyCycleThreshold?: number;
  /** When true, large/many cycles fail the gate instead of warning. */
  failOnLarge?: boolean;
}

/**
 * Surface import cycles in the file-import graph. Uses the persisted
 * `cycleCount` / `largestCycleSize` from `IGraphManifest` so the gate
 * is O(1) — no recomputation. Mirrors the doctor's heuristic: large
 * cycles or many cycles → advisory by default, fail when caller opts in.
 */
export function graphCyclesGate(
  projectRoot: string,
  options: IGraphCyclesGateOptions = {},
): IGateResult {
  const start = Date.now();
  const large = options.largeCycleSize ?? 3;
  const many = options.manyCycleThreshold ?? 5;
  const failOnLarge = options.failOnLarge ?? false;
  const store = new GraphStore(projectRoot);
  if (!store.exists()) {
    return {
      id: 'graph-cycles',
      label: 'Graph cycles',
      status: 'skipped',
      message: 'Skipped — graph index missing.',
      nextCommands: ['shrk graph index'],
      durationMs: Date.now() - start,
    };
  }
  const snap = store.loadSnapshot();
  const cycleCount = snap.manifest.cycleCount ?? 0;
  const largestCycleSize = snap.manifest.largestCycleSize ?? 0;
  const filesInCycles = snap.manifest.filesInCycles ?? 0;
  const triggered = largestCycleSize >= large || cycleCount >= many;
  if (!triggered) {
    return {
      id: 'graph-cycles',
      label: 'Graph cycles',
      status: 'pass',
      message: `${cycleCount} cycle(s); largest ${largestCycleSize}.`,
      details: { cycleCount, largestCycleSize, filesInCycles },
      durationMs: Date.now() - start,
    };
  }
  return {
    id: 'graph-cycles',
    label: 'Graph cycles',
    status: failOnLarge ? 'fail' : 'warn',
    message:
      `${cycleCount} import cycle(s); largest spans ${largestCycleSize} files; ` +
      `${filesInCycles} file(s) participate.`,
    details: { cycleCount, largestCycleSize, filesInCycles, threshold: { large, many } },
    nextCommands: ['shrk graph cycles', 'shrk arch check'],
    durationMs: Date.now() - start,
  };
}
