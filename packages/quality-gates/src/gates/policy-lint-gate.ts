import { coverageShortfall, type IPolicyRule } from '@shrkcrft/core';
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
  /**
   * Project-relative directories the walk prunes: THE plane scan scope
   * (`planeScanExcludeDirs`), the one `policy-lint` uses. The caller passes it
   * so this gate and the verb examine the same files for the same rule.
   */
  excludeDirs?: readonly string[];
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
      // Nothing declared was examined — never a clean `shrk gate` exit.
      coverage: [
        {
          unit: 'config files',
          expected: 1,
          examined: 0,
          subject: 'policy',
          reason: 'failed to load, so no policy rule was evaluated',
        },
      ],
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
    ...(options.excludeDirs ? { excludeDirs: options.excludeDirs } : {}),
  });

  // Nothing SELECTED: no rule has content in the run's scope (`--changed-only`
  // left none — no rule's globs match content the change touched). That is
  // deliberate narrowing, not a gap in any rule — skipped, loudly, never a
  // pass. A rule that WAS selected but scanned nothing is not this case; it
  // carries its coverage below.
  if (report.rules.length === 0) {
    return {
      id: 'policy',
      label: 'Policy lint',
      status: 'skipped',
      message: 'No policy rules in scope — nothing evaluated.',
      details: { evaluated: 0 },
      durationMs: Date.now() - start,
    };
  }

  // The engine's per-rule coverage (`IPolicyRuleResult.coverage`), owned by the
  // rule id — the ONE record `policy-lint`, `gates check` and `quality` settle
  // on. Carried on EVERY result below, so `shrk gate` settles its exit on the
  // same records (settleVerdict): a rule that scanned nothing is not a pass
  // here either, whether it sits next to a live rule or alone.
  const coverage = report.rules.map((r) => ({ ...r.coverage, subject: r.coverage.subject ?? r.ruleId }));
  const shortfalls = coverage.flatMap((c) => {
    const s = coverageShortfall(c);
    return s === undefined ? [] : [`${c.subject}: ${s}`];
  });
  const more = shortfalls.length > 1 ? ` (+${shortfalls.length - 1} more)` : '';
  // A rule that matched nothing under `failOnEmpty` (the default at `error`
  // severity) FAILED: `policy-lint` exits 1 on it, so this gate fails too.
  const emptyFailed = report.skipped.filter((s) => s.failed).map((s) => s.ruleId);
  const failedOnEmpty = emptyFailed.length > 0 ? { failedOnEmpty: emptyFailed } : {};
  const failed = report.verdict === 'errors' || emptyFailed.length > 0;
  const errors = report.findings.filter((f) => f.severity === 'error').length;
  const warnings = report.findings.filter((f) => f.severity === 'warning').length;
  const samples = report.findings
    .slice(0, 8)
    .map((f) => `${f.ruleId}: ${f.match} (${f.file}:${f.line})`);
  const diagnostics = report.diagnostics;

  // Rules were selected, but none scanned a content unit (their globs matched
  // no files). The selected rule set proved nothing: `warn` + coverage (NOT
  // VERIFIED — `shrk gate` settles it to 2), or `fail` when a failOnEmpty rule
  // failed. Never `skipped`, which `shrk gate` would read as a clean 0.
  if (report.evaluated === 0) {
    return {
      id: 'policy',
      label: 'Policy lint',
      status: failed ? 'fail' : 'warn',
      message: failed
        ? `FAILED — nothing evaluated: ${emptyFailed.length} rule(s) matched no content and fail on empty (${emptyFailed.join(', ')}). A rule that matches nothing is a bug in the rule.`
        : `NOT VERIFIED — nothing evaluated: ${shortfalls[0] ?? 'no selected rule scanned a content unit'}${more}. This is not a pass.`,
      details: { rules: report.rules.length, evaluated: 0, shortfalls, ...failedOnEmpty },
      coverage,
      nextCommands: ['shrk policy-lint'],
      durationMs: Date.now() - start,
    };
  }

  if (report.verdict === 'pass') {
    if (shortfalls.length > 0) {
      return {
        id: 'policy',
        label: 'Policy lint',
        status: 'warn',
        message: `NOT VERIFIED — ${shortfalls[0]}${more}. No violations among what was scanned; this is not a pass.`,
        details: { rules: report.rules.length, evaluated: report.evaluated, shortfalls },
        coverage,
        nextCommands: ['shrk policy-lint'],
        durationMs: Date.now() - start,
      };
    }
    return {
      id: 'policy',
      label: 'Policy lint',
      status: 'pass',
      message: `${report.rules.length} policy rule(s) — no violations.`,
      details: { rules: report.rules.length, evaluated: report.evaluated },
      coverage,
      durationMs: Date.now() - start,
    };
  }
  const misconfig = diagnostics.length > 0 ? `, ${diagnostics.length} misconfigured rule(s)` : '';
  const empty =
    emptyFailed.length > 0 ? `, ${emptyFailed.length} rule(s) matched nothing (failOnEmpty: ${emptyFailed.join(', ')})` : '';
  return {
    id: 'policy',
    label: 'Policy lint',
    status: failed ? 'fail' : 'warn',
    message: `${errors} error(s), ${warnings} warning(s)${misconfig}${empty}: policy violation(s).`,
    details: {
      errors,
      warnings,
      samples,
      evaluated: report.evaluated,
      ...(diagnostics.length > 0 ? { diagnostics } : {}),
      ...(shortfalls.length > 0 ? { shortfalls } : {}),
      ...failedOnEmpty,
    },
    coverage,
    nextCommands: ['shrk policy-lint'],
    durationMs: Date.now() - start,
  };
}
