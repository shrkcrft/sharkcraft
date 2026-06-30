import type { IWiringRule } from '@shrkcrft/core';
import { runWiring } from '@shrkcrft/boundaries';
import type { IGateResult } from '../schema/quality-gate.ts';

export interface IWiringGateOptions {
  /** The project's wiring rules (from `sharkcraft.config.ts` `wiringRules[]`). */
  rules?: readonly IWiringRule[];
  /** Restrict to rules touched by these (project-relative) changed files. */
  changedFiles?: readonly string[];
  /** When true, only run rules touched by `changedFiles`. */
  changedOnly?: boolean;
  /**
   * Set when the project config could not be loaded/validated. The gate surfaces
   * it (warn) instead of silently skipping — a malformed config must not quietly
   * disable the wiring plane.
   */
  configError?: string;
}

/**
 * The "completeness plane" gate: runs the project's data-defined wiring rules
 * (declared token set ⊆ registered token set). Skipped — never red — when no
 * rules are configured, so it's inert for projects that don't opt in.
 */
export function wiringGate(projectRoot: string, options: IWiringGateOptions = {}): IGateResult {
  const start = Date.now();
  if (options.configError) {
    return {
      id: 'wiring',
      label: 'Wiring (completeness)',
      status: 'warn',
      message: `Config could not be loaded — wiring rules not evaluated: ${options.configError}`,
      nextCommands: ['shrk doctor'],
      durationMs: Date.now() - start,
    };
  }
  const rules = options.rules ?? [];
  if (rules.length === 0) {
    return {
      id: 'wiring',
      label: 'Wiring (completeness)',
      status: 'skipped',
      message: 'No wiring rules configured (sharkcraft.config.ts wiringRules[]).',
      durationMs: Date.now() - start,
    };
  }

  const report = runWiring(projectRoot, rules, {
    ...(options.changedOnly ? { changedOnly: true, changedFiles: options.changedFiles ?? [] } : {}),
  });

  // Loud zero case: rules exist but none actually ran a comparison (their globs
  // matched no files, or `--changed-only` filtered them all out). Surface it as
  // skipped rather than a silent green pass.
  if (report.rules.length === 0 || report.evaluated === 0) {
    return {
      id: 'wiring',
      label: 'Wiring (completeness)',
      status: 'skipped',
      message: 'No wiring rules in scope — nothing evaluated.',
      details: { evaluated: 0 },
      durationMs: Date.now() - start,
    };
  }

  const errors = report.violations.filter((v) => v.severity === 'error').length;
  const warnings = report.violations.filter((v) => v.severity === 'warning').length;
  const samples = report.violations.slice(0, 8).map((v) => `${v.ruleId}: ${v.token} (${v.file}:${v.line})`);
  const diagnostics = report.diagnostics;

  if (report.verdict === 'pass') {
    return {
      id: 'wiring',
      label: 'Wiring (completeness)',
      status: 'pass',
      message: `${report.rules.length} wiring rule(s) — every declared token is wired.`,
      details: { rules: report.rules.length, evaluated: report.evaluated },
      durationMs: Date.now() - start,
    };
  }
  const misconfig = diagnostics.length > 0 ? `, ${diagnostics.length} misconfigured rule(s)` : '';
  return {
    id: 'wiring',
    label: 'Wiring (completeness)',
    status: report.verdict === 'errors' ? 'fail' : 'warn',
    message: `${errors} error(s), ${warnings} warning(s)${misconfig}: declared but not wired.`,
    details: {
      errors,
      warnings,
      samples,
      evaluated: report.evaluated,
      ...(diagnostics.length > 0 ? { diagnostics } : {}),
    },
    nextCommands: ['shrk check wiring'],
    durationMs: Date.now() - start,
  };
}
