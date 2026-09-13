import { coverageShortfall, type IWiringRule } from '@shrkcrft/core';
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
  /**
   * Project-relative directories the walk prunes: THE plane scan scope
   * (`planeScanExcludeDirs`), the one `check wiring` uses. The caller passes
   * it so this gate and the verb examine the same files for the same rule.
   */
  excludeDirs?: readonly string[];
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
      // Nothing declared was examined — never a clean `shrk gate` exit.
      coverage: [
        {
          unit: 'config files',
          expected: 1,
          examined: 0,
          subject: 'wiring',
          reason: 'failed to load, so no wiring rule was evaluated',
        },
      ],
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
    ...(options.excludeDirs ? { excludeDirs: options.excludeDirs } : {}),
  });

  // Nothing SELECTED: `--changed-only` filtered every rule out (no rule's
  // footprint intersects the changeset). That is deliberate narrowing, not a
  // gap in any rule — skipped, loudly, never a pass. A rule that WAS selected
  // but examined nothing is not this case; it carries its coverage below.
  if (report.rules.length === 0) {
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
  // Every rule's coverage shortfall, through core's one rule — the same set
  // `check wiring` / `gates check` settle their exit on. A rule that passed
  // over part of its scope (a subset rule whose declared selector never
  // produced some registered tokens) or checked nothing is NOT a pass here
  // either, so `shrk gate`, the MCP quality-gate tool and the dashboard cannot
  // read green where `check wiring` reads not-verified.
  // The engine's per-rule coverage, owned by the rule id — carried on the
  // result so `shrk gate` settles its EXIT on the same records (settleVerdict),
  // and the `shortfalls` detail below is a rendering of them, not a re-derivation.
  const coverage = report.rules.map((r) => ({ ...r.coverage, subject: r.coverage.subject ?? r.ruleId }));
  const shortfalls = coverage.flatMap((c) => {
    const s = coverageShortfall(c);
    return s === undefined ? [] : [`${c.subject}: ${s}`];
  });
  const more = shortfalls.length > 1 ? ` (+${shortfalls.length - 1} more)` : '';
  // A rule that matched nothing under `failOnEmpty` carries no violation of its
  // own — named next to the counts so a failing result says what failed.
  const emptyFailed = report.skipped.filter((s) => s.failed).map((s) => s.ruleId);
  const failedOnEmpty = emptyFailed.length > 0 ? { failedOnEmpty: emptyFailed } : {};

  // Rules were SELECTED, but none ran a comparison (their source globs matched
  // no files, or extracted no ids). The selected rule set proved nothing:
  // `warn` + coverage (NOT VERIFIED — `shrk gate` settles it to 2), or `fail`
  // when an error-severity failOnEmpty rule failed — exactly where `check
  // wiring` exits 1. Never `skipped`, which `shrk gate` would read as a 0.
  if (report.evaluated === 0) {
    const failed = report.verdict === 'errors';
    return {
      id: 'wiring',
      label: 'Wiring (completeness)',
      status: failed ? 'fail' : 'warn',
      message: failed
        ? `FAILED — nothing evaluated: ${emptyFailed.length} rule(s) matched nothing and fail on empty (${emptyFailed.join(', ')}). A rule that matches nothing is a bug in the rule.`
        : `NOT VERIFIED — nothing evaluated: ${shortfalls[0] ?? 'no selected rule ran a comparison'}${more}. This is not a pass.`,
      details: { rules: report.rules.length, evaluated: 0, shortfalls, ...failedOnEmpty },
      coverage,
      nextCommands: ['shrk check wiring'],
      durationMs: Date.now() - start,
    };
  }

  if (report.verdict === 'pass') {
    if (shortfalls.length > 0) {
      return {
        id: 'wiring',
        label: 'Wiring (completeness)',
        status: 'warn',
        message: `NOT VERIFIED — ${shortfalls[0]}${more}. No violations among what was examined; this is not a pass.`,
        details: { rules: report.rules.length, evaluated: report.evaluated, shortfalls },
        coverage,
        nextCommands: ['shrk check wiring'],
        durationMs: Date.now() - start,
      };
    }
    return {
      id: 'wiring',
      label: 'Wiring (completeness)',
      status: 'pass',
      message: `${report.rules.length} wiring rule(s) — every declared token is wired.`,
      details: { rules: report.rules.length, evaluated: report.evaluated },
      // Carries any explicit acceptance (registeredExtras) so it is printed.
      coverage,
      durationMs: Date.now() - start,
    };
  }
  const misconfig = diagnostics.length > 0 ? `, ${diagnostics.length} misconfigured rule(s)` : '';
  const empty =
    emptyFailed.length > 0 ? `, ${emptyFailed.length} rule(s) matched nothing (failOnEmpty: ${emptyFailed.join(', ')})` : '';
  return {
    id: 'wiring',
    label: 'Wiring (completeness)',
    status: report.verdict === 'errors' ? 'fail' : 'warn',
    message: `${errors} error(s), ${warnings} warning(s)${misconfig}${empty}: declared but not wired.`,
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
    nextCommands: ['shrk check wiring'],
    durationMs: Date.now() - start,
  };
}
