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
    const baselineErrors = baseline.countsBySeverity.error;

    // §3.1 — change-scoped attribution. "NEW since baseline" is a drift measure
    // against a frozen (possibly months-old) snapshot; on its own it red-fails
    // on structural debt the current change never touched, training the agent to
    // ignore the gate. Redefine the BLOCKING set as the intersection of the
    // baseline-new violations with the files the working diff actually touched
    // (diff vs HEAD). A NEW violation whose origin file is NOT in the changed set
    // becomes INFORMATIONAL baseline drift — it never flips the exit code
    // (mirroring how baseline debt is already non-blocking). When no changed set
    // is supplied (`changedFiles === undefined`), fall back to the legacy
    // behaviour where any NEW violation blocks.
    const scoped = options.changedFiles !== undefined;
    const changedSet = new Set((options.changedFiles ?? []).map(normaliseRel));
    const attributable = scoped
      ? newViolations.filter((v) => fileInChangedSet(v.file, changedSet))
      : newViolations;
    const drift = scoped
      ? newViolations.filter((v) => !fileInChangedSet(v.file, changedSet))
      : [];

    const newErrors = attributable.filter((v) => v.severity === 'error').length;
    const newWarnings = attributable.filter((v) => v.severity === 'warning').length;
    const driftErrors = drift.filter((v) => v.severity === 'error').length;
    const driftWarnings = drift.filter((v) => v.severity === 'warning').length;
    const driftNote =
      scoped && driftErrors + driftWarnings > 0
        ? ` Baseline drift in untouched files: ${driftErrors} error(s), ${driftWarnings} warning(s) (informational — re-freeze with \`shrk gate baseline --refreeze\`).`
        : '';

    if (newErrors > 0) {
      return {
        id: 'arch',
        label: 'Architecture',
        status: 'fail',
        message: `${newErrors} NEW architecture error(s) introduced by this change (baseline debt: ${baselineErrors}, informational).${driftNote}`,
        details: {
          newErrors,
          newWarnings,
          baselineErrors,
          totalErrors: errors,
          driftErrors,
          driftWarnings,
          changeScoped: scoped,
          newViolationIds: attributable.map(violationId),
          driftViolationIds: drift.map(violationId),
        },
        nextCommands: ['shrk arch check', 'shrk arch baseline show'],
        durationMs: Date.now() - start,
      };
    }
    if (newWarnings > 0) {
      return {
        id: 'arch',
        label: 'Architecture',
        status: 'warn',
        message: `${newWarnings} new architecture warning(s) introduced by this change (baseline debt: ${baselineErrors} error(s), informational).${driftNote}`,
        details: {
          newWarnings,
          baselineErrors,
          totalErrors: errors,
          totalWarnings: warnings,
          driftErrors,
          driftWarnings,
          changeScoped: scoped,
        },
        nextCommands: ['shrk arch check'],
        durationMs: Date.now() - start,
      };
    }
    // No change-attributable NEW violation. This is a PASS for THIS change even
    // when baseline drift persists in untouched files — surface that drift as
    // informational rather than reporting a misleading all-clear over zero
    // attributed errors (the honest exit-code posture).
    const passMessage =
      scoped && driftErrors + driftWarnings > 0
        ? `No change-attributable architecture errors (baseline debt: ${baselineErrors} error(s), informational).${driftNote}`
        : errors > 0
          ? `No NEW architecture violations (baseline debt: ${baselineErrors} error(s), informational).`
          : 'No architecture violations.';
    return {
      id: 'arch',
      label: 'Architecture',
      status: 'pass',
      message: passMessage,
      details: {
        baselineErrors,
        totalErrors: errors,
        driftErrors,
        driftWarnings,
        changeScoped: scoped,
      },
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

/** Slash-normalise a project-relative path and strip a leading `./`. */
function normaliseRel(input: string): string {
  return input.split(/[\\/]/).join('/').replace(/^\.\//, '');
}

/**
 * True when a violation's origin file is in the changed-file set. Both sides are
 * project-relative; the suffix match is a safety net for callers that pass
 * changed paths with a differing prefix depth (mirrors the boundary changed-only
 * filter's fuzzy tail match).
 */
function fileInChangedSet(file: string, changedSet: ReadonlySet<string>): boolean {
  if (changedSet.size === 0) return false;
  const norm = normaliseRel(file);
  if (changedSet.has(norm)) return true;
  for (const cf of changedSet) {
    if (cf.length > 0 && (norm === cf || norm.endsWith('/' + cf) || cf.endsWith('/' + norm))) {
      return true;
    }
  }
  return false;
}
