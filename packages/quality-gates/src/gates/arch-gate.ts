import { runArchCheck } from '@shrkcrft/architecture-guard';
import type { IGateResult } from '../schema/quality-gate.ts';

/**
 * Architecture-guard gate. Pass when zero error-severity violations.
 * Warnings (fat barrels, 2-node cycles, adapter leaks) are reported
 * as `warn` — the gate doesn't fail, but the human sees them.
 */
export function archGate(projectRoot: string): IGateResult {
  const start = Date.now();
  const report = runArchCheck({ projectRoot });
  if (report.diagnostics.some((d) => d.includes('code-graph store missing'))) {
    return {
      id: 'arch',
      label: 'Architecture',
      status: 'skipped',
      message: 'Skipped — graph index missing.',
      nextCommands: ['shrk graph index'],
      durationMs: Date.now() - start,
    };
  }
  const errors = report.countsBySeverity.error;
  const warnings = report.countsBySeverity.warning;
  if (errors > 0) {
    return {
      id: 'arch',
      label: 'Architecture',
      status: 'fail',
      message: `${errors} architecture error(s).`,
      details: {
        errors,
        warnings,
        kinds: report.countsByKind,
      },
      nextCommands: ['shrk arch check'],
      durationMs: Date.now() - start,
    };
  }
  if (warnings > 0) {
    return {
      id: 'arch',
      label: 'Architecture',
      status: 'warn',
      message: `${warnings} architecture warning(s).`,
      details: { warnings, kinds: report.countsByKind },
      nextCommands: ['shrk arch check'],
      durationMs: Date.now() - start,
    };
  }
  return {
    id: 'arch',
    label: 'Architecture',
    status: 'pass',
    message: 'No architecture violations.',
    durationMs: Date.now() - start,
  };
}
