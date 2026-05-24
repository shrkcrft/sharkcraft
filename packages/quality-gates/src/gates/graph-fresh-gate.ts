import { GraphStore } from '@shrkcrft/graph';
import type { IGateResult } from '../schema/quality-gate.ts';

/**
 * Check whether the code-graph store exists AND the manifest digest
 * matches the on-disk JSONL fingerprints. Catches: missing index;
 * tampered / partial store; schema mismatch.
 */
export function graphFreshGate(projectRoot: string): IGateResult {
  const start = Date.now();
  const store = new GraphStore(projectRoot);
  if (!store.exists()) {
    return {
      id: 'graph-fresh',
      label: 'Code graph indexed',
      status: 'fail',
      message: 'Code-graph store missing.',
      nextCommands: ['shrk graph index'],
      durationMs: Date.now() - start,
    };
  }
  const verify = store.verifyDigest();
  if (!verify.ok) {
    return {
      id: 'graph-fresh',
      label: 'Code graph indexed',
      status: 'fail',
      message: 'Code-graph digest mismatch — store may be tampered or partial.',
      details: { expected: verify.expected, actual: verify.actual },
      nextCommands: ['shrk graph index'],
      durationMs: Date.now() - start,
    };
  }
  return {
    id: 'graph-fresh',
    label: 'Code graph indexed',
    status: 'pass',
    message: 'Code-graph index is fresh.',
    durationMs: Date.now() - start,
  };
}
