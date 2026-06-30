import {
  ArchReportStore,
  diffSnapshots,
  runArchCheck,
  snapshotFromReport,
  violationId,
} from '@shrkcrft/architecture-guard';
import type { IArchGateOptions } from '../schema/arch-gate-options.ts';
import type { IGateResult } from '../schema/quality-gate.ts';

/**
 * Architecture-guard gate.
 *
 * When a frozen baseline exists and `baselineRelative` is not disabled (the
 * DEFAULT), the gate fails only on NEW architecture errors — violations absent
 * from the baseline — and surfaces the total pre-existing debt as informational.
 * This stops the gate from being a perpetual red on baseline debt the current
 * diff never introduced (an agent learns to ignore a gate that's always red).
 *
 * When no baseline is frozen, errors are reported as `warn` (not `fail`) so the
 * gate isn't a perpetual red on inherited debt the current diff never
 * introduced — an agent learns to ignore a gate that's always red. `--strict`
 * still escalates the warn to a failure for CI, and freezing a baseline switches
 * on NEW-only gating. When `baselineRelative: false` (the `--arch-all` opt-in),
 * the gate fails on ANY error regardless of the baseline, keeping a clean-tree
 * CI demand expressible.
 *
 * Warnings never fail the gate; they are reported as `warn`.
 */
export function archGate(projectRoot: string, options: IArchGateOptions = {}): IGateResult {
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

  const baseline =
    options.baselineRelative === false ? undefined : new ArchReportStore(projectRoot).readBaseline();

  if (baseline) {
    const current = snapshotFromReport(report);
    const delta = diffSnapshots(baseline, current);
    const newIds = new Set(delta.newViolationIds);
    const newViolations = report.violations.filter((v) => newIds.has(violationId(v)));
    const newErrors = newViolations.filter((v) => v.severity === 'error').length;
    const newWarnings = newViolations.filter((v) => v.severity === 'warning').length;
    const baselineErrors = baseline.countsBySeverity.error;
    if (newErrors > 0) {
      return {
        id: 'arch',
        label: 'Architecture',
        status: 'fail',
        message: `${newErrors} NEW architecture error(s) since baseline (baseline debt: ${baselineErrors}, informational).`,
        details: { newErrors, newWarnings, baselineErrors, totalErrors: errors, newViolationIds: delta.newViolationIds },
        nextCommands: ['shrk arch check', 'shrk arch baseline show'],
        durationMs: Date.now() - start,
      };
    }
    if (newWarnings > 0) {
      return {
        id: 'arch',
        label: 'Architecture',
        status: 'warn',
        message: `${newWarnings} new architecture warning(s) since baseline (baseline debt: ${baselineErrors} error(s), informational).`,
        details: { newWarnings, baselineErrors, totalErrors: errors, totalWarnings: warnings },
        nextCommands: ['shrk arch check'],
        durationMs: Date.now() - start,
      };
    }
    return {
      id: 'arch',
      label: 'Architecture',
      status: 'pass',
      message:
        errors > 0
          ? `No NEW architecture violations (baseline debt: ${baselineErrors} error(s), informational).`
          : 'No architecture violations.',
      details: { baselineErrors, totalErrors: errors },
      durationMs: Date.now() - start,
    };
  }

  // No baseline available: either none is frozen (the default state of a fresh
  // repo) or the caller disabled baseline-relative gating via `--arch-all`.
  if (errors > 0) {
    if (options.baselineRelative === false) {
      // Explicit opt-in (`--arch-all`): fail on TOTAL errors so a clean-tree CI
      // demand stays expressible.
      return {
        id: 'arch',
        label: 'Architecture',
        status: 'fail',
        message: `${errors} architecture error(s).`,
        details: { errors, warnings, kinds: report.countsByKind },
        nextCommands: ['shrk arch check', 'shrk arch baseline write'],
        durationMs: Date.now() - start,
      };
    }
    // Default: no baseline frozen. Don't hard-fail on pre-existing debt the
    // current diff never introduced — warn (so the signal stays visible) and
    // point at freezing a baseline to switch on NEW-only gating. `--strict`
    // still turns this warn into a hard failure for CI, and `--arch-all` fails
    // on the total.
    return {
      id: 'arch',
      label: 'Architecture',
      status: 'warn',
      message: `${errors} architecture error(s), no baseline frozen — not failing the gate (freeze one with \`shrk arch baseline write\` to track regressions; use \`--arch-all\` or \`--strict\` to fail).`,
      details: { errors, warnings, kinds: report.countsByKind, noBaseline: true },
      nextCommands: ['shrk arch baseline write', 'shrk arch check'],
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
