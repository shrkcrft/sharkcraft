import { PatternRegistryStore } from '@shrkcrft/structural-search';
import type { IGateResult } from '../schema/quality-gate.ts';

export interface IStructuralPatternsGateOptions {
  /**
   * When true, an invalid registry entry fails the gate. Default
   * `false` (warn) — broken patterns are a config issue, not a
   * shippability blocker by themselves.
   */
  failOnInvalid?: boolean;
}

/**
 * Validate the structural-pattern registry. Skipped when the registry
 * file doesn't exist. Re-validates every entry in-memory (no fs writes
 * here — the CLI's `registry validate` is the persistence path).
 */
export function structuralPatternsGate(
  projectRoot: string,
  options: IStructuralPatternsGateOptions = {},
): IGateResult {
  const start = Date.now();
  const failOnInvalid = options.failOnInvalid ?? false;
  const store = new PatternRegistryStore(projectRoot);
  if (!store.exists()) {
    return {
      id: 'structural-patterns',
      label: 'Structural pattern registry',
      status: 'skipped',
      message: 'No pattern registry — feature is opt-in.',
      durationMs: Date.now() - start,
    };
  }
  const reg = store.read();
  if (reg.patterns.length === 0) {
    return {
      id: 'structural-patterns',
      label: 'Structural pattern registry',
      status: 'skipped',
      message: 'Pattern registry is empty.',
      durationMs: Date.now() - start,
    };
  }
  const result = store.validateAll();
  if (result.failed === 0) {
    return {
      id: 'structural-patterns',
      label: 'Structural pattern registry',
      status: 'pass',
      message: `${result.total} pattern(s) valid.`,
      details: { total: result.total },
      durationMs: Date.now() - start,
    };
  }
  return {
    id: 'structural-patterns',
    label: 'Structural pattern registry',
    status: failOnInvalid ? 'fail' : 'warn',
    message: `${result.failed}/${result.total} pattern(s) failed validation.`,
    details: { total: result.total, failed: result.failed, errors: result.errors },
    nextCommands: ['shrk search-structural registry validate', 'shrk search-structural registry list'],
    durationMs: Date.now() - start,
  };
}
