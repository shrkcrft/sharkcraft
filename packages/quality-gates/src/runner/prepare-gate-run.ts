import { planeScanExcludeDirs } from '@shrkcrft/boundaries';
import { settleVerdict, type ISettledVerdict } from '@shrkcrft/core';
import {
  inspectSharkcraft,
  resolveChangedFiles,
  resolveProjectConfig,
  type ISharkcraftInspection,
} from '@shrkcrft/inspector';
import type { IGateRunRequest } from '../schema/gate-run-request.ts';
import type { IPreparedGateRun } from '../schema/prepared-gate-run.ts';
import type { GateStatus, IQualityGateReport } from '../schema/quality-gate.ts';

/**
 * THE option assembly for a quality-gate run — `shrk gate` and MCP
 * `get_quality_gate` both call it, so the two cannot run different gate sets.
 *
 * Round 11 review: the MCP tool passed only the impact options, so it never
 * loaded the project's wiring / policy rules or the knowledge inspection —
 * it said "No wiring rules configured" over a failing rule and returned
 * `overall: pass` where `shrk gate` exited 1.
 *
 *   - wiring + policy rules come from `resolveProjectConfig` (pack
 *     contributions included); an INVALID config is surfaced to both gates
 *     (a `warn` with coverage), never a silent disable;
 *   - both gates walk THE plane scan scope (`planeScanExcludeDirs`);
 *   - `--changed-only` / `--staged` / `--files` / `--since` scope wiring,
 *     policy and knowledge-symbol to the changeset and drive the impact gate;
 *   - the architecture gate's NEW is always change-scoped (the worktree diff
 *     vs HEAD when no scope is given);
 *   - blast-radius risk is advisory unless `failOn` is given.
 */
export async function prepareQualityGateRun(req: IGateRunRequest): Promise<IPreparedGateRun> {
  const cwd = req.cwd;
  const files = req.files ?? [];
  const wantChangedScope =
    req.changedOnly === true || req.staged === true || Boolean(req.sinceRef) || files.length > 0;
  let changedFiles: readonly string[] | undefined;
  if (wantChangedScope) {
    changedFiles = resolveChangedFiles({
      projectRoot: cwd,
      ...(files.length > 0 ? { files: [...files] } : {}),
      ...(req.staged ? { staged: true } : {}),
      ...(req.sinceRef ? { since: req.sinceRef } : {}),
      ...(req.changedOnly && !req.staged && !req.sinceRef && files.length === 0 ? { includeWorktree: true } : {}),
    }).files;
  }
  const loadedConfig = await resolveProjectConfig(cwd);
  const wiringRules = loadedConfig.ok ? (loadedConfig.value.config.wiringRules ?? []) : [];
  const policyRules = loadedConfig.ok ? (loadedConfig.value.config.policyRules ?? []) : [];
  const configError = loadedConfig.ok ? undefined : loadedConfig.error.message;
  const excludeDirs = loadedConfig.ok ? planeScanExcludeDirs(cwd, loadedConfig.value.sharkcraftDir) : undefined;
  const scopeOpts = wantChangedScope ? { changedOnly: true, changedFiles: changedFiles ?? [] } : {};
  // §3.1 — the architecture gate's "NEW" is ALWAYS change-scoped: a NEW error
  // means one introduced by the working change (diff vs HEAD), never drift
  // against a frozen (possibly months-old) baseline in a file the change never
  // touched. `archAll` (baselineRelative:false) ignores this and fails on total
  // errors, keeping a clean-tree CI demand expressible.
  const archChangedFiles: readonly string[] = wantChangedScope
    ? (changedFiles ?? [])
    : resolveChangedFiles({ projectRoot: cwd, includeWorktree: true }).files;
  // Knowledge symbol-ref integrity needs the loaded knowledge entries. A
  // caller that already has an inspection (MCP) passes it; otherwise one is
  // built — best-effort: a failed inspection skips the gate, never fails it.
  let inspection: ISharkcraftInspection | undefined = req.inspection;
  if (!inspection && !req.disable?.includes('knowledge-symbol')) {
    try {
      inspection = await inspectSharkcraft({ cwd });
    } catch {
      inspection = undefined;
    }
  }
  return {
    options: {
      projectRoot: cwd,
      arch: {
        ...(req.archAll ? { baselineRelative: false } : {}),
        changedFiles: archChangedFiles,
      },
      wiring: {
        ...(configError ? { configError } : wiringRules.length > 0 ? { rules: wiringRules } : {}),
        ...scopeOpts,
        ...(excludeDirs ? { excludeDirs } : {}),
      },
      policy: {
        ...(configError ? { configError } : policyRules.length > 0 ? { rules: policyRules } : {}),
        ...scopeOpts,
        ...(excludeDirs ? { excludeDirs } : {}),
      },
      ...(inspection
        ? {
            knowledgeSymbol: {
              inspection,
              ...(wantChangedScope ? { changedFiles: changedFiles ?? [] } : {}),
            },
          }
        : {}),
      impact: {
        ...(req.sinceRef ? { sinceRef: req.sinceRef } : {}),
        // Blast-radius risk is PRE-EXISTING structure, so the composite gate
        // treats it as advisory by default — `failOn: []` warns instead of
        // redding. `failOn: ['critical']` opts into a hard fail.
        failOn: req.failOn ?? [],
        // With `--since` the gitref diff drives it; with `--changed-only` /
        // `--staged` / `--files` the resolved changed-file set does.
        ...(wantChangedScope && !req.sinceRef ? { files: changedFiles ?? [] } : {}),
      },
      ...(req.apiDiff ? { apiDiff: req.apiDiff } : {}),
      ...(req.disable ? { disable: req.disable } : {}),
    },
    planeDiagnostics: loadedConfig.ok ? loadedConfig.value.planeDiagnostics : [],
    ...(changedFiles ? { changedFiles } : {}),
  };
}

/** The PROPOSED exit from the overall status; the settle may veto a clean one. */
export function qualityGateProposedExit(overall: GateStatus, strict: boolean): number {
  if (overall === 'fail') return 1;
  if (overall === 'warn' && strict) return 1;
  return 0;
}

/**
 * THE settlement of a quality-gate report: the proposed exit (from `overall`,
 * `--strict` promoting a warn) vetoed by any gate coverage with a shortfall —
 * core's `settleVerdict`, so a `warn` that says "this is not a pass" never
 * settles to 0. `shrk gate` and MCP `get_quality_gate` both call it.
 */
export function settleQualityGateReport(report: IQualityGateReport, strict = false): ISettledVerdict {
  return settleVerdict(
    qualityGateProposedExit(report.overall, strict),
    report.gates.flatMap((g) => g.coverage ?? []),
  );
}
