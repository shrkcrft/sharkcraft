import type { IPolicyRule } from '@shrkcrft/core';
import { runPolicyLint } from '@shrkcrft/boundaries';
import type { IGateResult } from '../schema/quality-gate.ts';

export interface IPolicyLintGateOptions {
  /** The project's policy rules (from `sharkcraft.config.ts` `policyRules[]`). */
  rules?: readonly IPolicyRule[];
  /** Restrict to rules whose globs match one of these (project-relative) changed files. */
  changedFiles?: readonly string[];
  /** When true, only run rules touched by `changedFiles`. */
  changedOnly?: boolean;
  /**
   * Set when the project config could not be loaded/validated. The gate surfaces
   * it (warn) instead of silently skipping — a malformed config must not quietly
   * disable the policy plane.
   */
  configError?: string;
}

/**
 * The "policy plane" gate: runs the project's data-defined policy-lint rules
 * (template / markup / stylesheet / AOT-invisible TS surfaces that tsc cannot
 * see). Skipped — never red — when no rules are configured, so it's inert for
 * projects that don't opt in. Honors the loud-zero contract: rules that exist
 * but fall out of the changed-only scope report `skipped`, never a silent pass.
 */
export function policyLintGate(projectRoot: string, options: IPolicyLintGateOptions = {}): IGateResult {
  const start = Date.now();
  if (options.configError) {
    return {
      id: 'policy',
      label: 'Policy lint',
      status: 'warn',
      message: `Config could not be loaded — policy rules not evaluated: ${options.configError}`,
      nextCommands: ['shrk doctor'],
      durationMs: Date.now() - start,
    };
  }
  const rules = options.rules ?? [];
  if (rules.length === 0) {
    return {
      id: 'policy',
      label: 'Policy lint',
      status: 'skipped',
      message: 'No policy rules configured (sharkcraft.config.ts policyRules[]).',
      durationMs: Date.now() - start,
    };
  }

  const report = runPolicyLint(projectRoot, rules, {
    ...(options.changedOnly ? { changedOnly: true, changedFiles: options.changedFiles ?? [] } : {}),
  });

  // Loud zero case: rules exist but none actually scanned a file (their globs
  // matched no files — e.g. a `style` rule in a project with no stylesheets — or
  // `--changed-only` filtered them all out). Surface it as skipped rather than a
  // silent green pass.
  if (report.rules.length === 0 || report.evaluated === 0) {
    return {
      id: 'policy',
      label: 'Policy lint',
      status: 'skipped',
      message: 'No policy rules in scope — nothing evaluated.',
      details: { evaluated: 0 },
      durationMs: Date.now() - start,
    };
  }

  const errors = report.findings.filter((f) => f.severity === 'error').length;
  const warnings = report.findings.filter((f) => f.severity === 'warning').length;
  const samples = report.findings
    .slice(0, 8)
    .map((f) => `${f.ruleId}: ${f.match} (${f.file}:${f.line})`);
  const diagnostics = report.diagnostics;

  if (report.verdict === 'pass') {
    return {
      id: 'policy',
      label: 'Policy lint',
      status: 'pass',
      message: `${report.rules.length} policy rule(s) — no violations.`,
      details: { rules: report.rules.length, evaluated: report.evaluated },
      durationMs: Date.now() - start,
    };
  }
  const misconfig = diagnostics.length > 0 ? `, ${diagnostics.length} misconfigured rule(s)` : '';
  return {
    id: 'policy',
    label: 'Policy lint',
    status: report.verdict === 'errors' ? 'fail' : 'warn',
    message: `${errors} error(s), ${warnings} warning(s)${misconfig}: policy violation(s).`,
    details: {
      errors,
      warnings,
      samples,
      evaluated: report.evaluated,
      ...(diagnostics.length > 0 ? { diagnostics } : {}),
    },
    nextCommands: ['shrk policy-lint'],
    durationMs: Date.now() - start,
  };
}
