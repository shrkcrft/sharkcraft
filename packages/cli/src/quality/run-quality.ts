import type { IQualityConfig, ISharkcraftInspection } from '@shrkcrft/inspector';
import { buildQualityReport } from '@shrkcrft/inspector';
import { GATE_PLANES, type IGateRuleView } from '../gates/gate-rule-view.ts';
import { runGatePlanes } from '../gates/run-gate-planes.ts';
import type { IGateRuleResult } from '../gates/gate-envelope.ts';

export const QUALITY_RUN_SCHEMA = 'sharkcraft.quality-run/v1' as const;

/**
 * Outcome of ONE gate in the pre-push bundle.
 *
 * `error` is deliberately distinct from `failed`: a gate that could not run
 * proved nothing, and folding it into either a pass or a violation is how an
 * unmeasured verdict ships as a green one.
 */
export type QualityItemStatus = 'passed' | 'failed' | 'skipped' | 'error';

export interface IQualityItem {
  readonly id: string;
  readonly label: string;
  readonly status: QualityItemStatus;
  /** `error` severity blocks the exit code; `warning` reports without failing. */
  readonly severity: 'error' | 'warning';
  readonly notes: readonly string[];
  /**
   * The exact command that reproduces THIS gate on its own.
   *
   * The aggregate exists to collapse a multi-round CI cascade into one local
   * run, and that only pays off if each failure is immediately actionable —
   * otherwise the developer's next step is to re-derive which verb produced the
   * line, which is the round-trip the aggregate was supposed to remove.
   */
  readonly repro: string;
  /** True when the skip was REQUESTED (scope / fail-fast), not accidental. */
  readonly skippedDeliberately?: boolean;
  /**
   * The gate's own structured payload — drift counts, boundary error totals, a
   * rule's declared/registered sizes.
   *
   * Carried per item rather than hoisted into one-off top-level fields: a
   * bundle that grows a `drift` key for the drift gate cannot keep doing that
   * as gates are added, and a CI consumer then has to know which gates got a
   * field and which did not.
   */
  readonly data?: Record<string, unknown>;
}

export interface IQualityRun {
  readonly schema: typeof QUALITY_RUN_SCHEMA;
  readonly items: readonly IQualityItem[];
  readonly passed: number;
  /** BLOCKING failures — an error-severity gate that ran and found violations. */
  readonly failed: number;
  /**
   * Failures that do NOT block, because the gate is warning-severity.
   *
   * Reported separately rather than folded into either bucket: a summary line
   * reading "0 failed" above a list containing FAIL rows is the kind of
   * self-contradiction that teaches people to stop trusting the summary.
   * `--strict` promotes these into {@link failed}.
   */
  readonly failedWarnings: number;
  readonly skipped: number;
  readonly errored: number;
  /** Gates that ran a real check (not skipped, not errored). */
  readonly evaluated: number;
  readonly verdict: 'pass' | 'fail' | 'not-verified';
  /** Set when the run was narrowed to a changeset. */
  readonly scopedFiles?: number;
  readonly failFast: boolean;
  readonly diagnostics: readonly string[];
}

export interface IRunQualityInput {
  readonly inspection: ISharkcraftInspection;
  readonly config: IQualityConfig;
  readonly strict: boolean;
  readonly failFast: boolean;
  /** Data-defined rules already narrowed to scope by the caller. */
  readonly gateRules: readonly IGateRuleView[];
  readonly cwd: string;
  readonly excludeDirs: readonly string[];
  readonly changedFiles?: readonly string[];
  /** Rules dropped because their footprint is outside the changeset. */
  readonly skippedByScope?: readonly IGateRuleView[];
  readonly planeDiagnostics?: readonly string[];
}

/** The isolated repro command for each inspector-bundle gate. */
const INSPECTOR_REPRO: Readonly<Record<string, string>> = Object.freeze({
  doctor: 'shrk doctor',
  readiness: 'shrk doctor',
  boundaries: 'shrk check boundaries',
  coverage: 'shrk coverage',
  drift: 'shrk drift',
  'context-tests': 'shrk test context',
  'agent-tests': 'shrk test agent',
  packs: 'shrk packs doctor',
});

/**
 * Run EVERY configured gate to completion and report every failure.
 *
 * A CI job that chains gates as separate steps stops at the first failing step,
 * so N independent failures cost N round-trips to discover — the classic case
 * being a first-ever run on a long-lived branch, where fixing gate A only
 * reveals gate B. The default here is therefore exhaustive: the point is to
 * surface the whole backlog in one local pass. `failFast` is available for the
 * opposite, CI-like behaviour, and says so in the report rather than making the
 * remaining gates look clean.
 */
export async function runQuality(input: IRunQualityInput): Promise<IQualityRun> {
  const items: IQualityItem[] = [];
  const diagnostics: string[] = [...(input.planeDiagnostics ?? [])];

  const report = await buildQualityReport({
    inspection: input.inspection,
    config: input.config,
    strict: input.strict,
  });
  for (const g of report.gates) {
    const status: QualityItemStatus = !g.executed ? 'error' : g.passed ? 'passed' : 'failed';
    items.push({
      id: g.id,
      label: g.label,
      status,
      severity: g.blocking ? 'error' : 'warning',
      notes: g.notes,
      repro: INSPECTOR_REPRO[g.id] ?? 'shrk quality',
      ...(g.data ? { data: g.data } : {}),
    });
  }

  const stopNow = (): boolean =>
    input.failFast && items.some((i) => i.status === 'failed' && i.severity === 'error');

  // The seven data-defined planes. Without them the "before you push" command
  // does not run the rules the repo actually declared, which is the gap that
  // makes `gates check` a separate step people forget.
  if (input.gateRules.length > 0 && !stopNow()) {
    const run = runGatePlanes(input.gateRules, {
      cwd: input.cwd,
      excludeDirs: input.excludeDirs,
      ...(input.changedFiles ? { changedFiles: input.changedFiles } : {}),
      inspection: input.inspection,
    });
    diagnostics.push(...run.diagnostics);
    for (const plane of GATE_PLANES) {
      for (const r of run.results.filter((x) => x.type === plane)) {
        items.push(planeItem(plane, r, input.strict));
      }
    }
  } else if (input.gateRules.length > 0) {
    for (const r of input.gateRules) {
      items.push({
        id: `${r.plane}:${r.id}`,
        label: `[${r.plane}] ${r.id}`,
        status: 'skipped',
        severity: 'warning',
        notes: ['not run — an earlier gate failed under --fail-fast'],
        repro: `shrk gates check --only ${r.id}`,
        skippedDeliberately: true,
      });
    }
  }

  for (const r of input.skippedByScope ?? []) {
    items.push({
      id: `${r.plane}:${r.id}`,
      label: `[${r.plane}] ${r.id}`,
      status: 'skipped',
      severity: 'warning',
      notes: ['outside the changeset'],
      repro: `shrk gates check --only ${r.id}`,
      skippedDeliberately: true,
    });
  }

  const failed = items.filter((i) => i.status === 'failed' && i.severity === 'error').length;
  const failedWarnings = items.filter(
    (i) => i.status === 'failed' && i.severity !== 'error',
  ).length;
  const errored = items.filter((i) => i.status === 'error').length;
  const accidentalSkips = items.filter(
    (i) => i.status === 'skipped' && i.skippedDeliberately !== true,
  ).length;
  const evaluated = items.filter((i) => i.status === 'passed' || i.status === 'failed').length;
  const verdict: IQualityRun['verdict'] =
    failed > 0
      ? 'fail'
      : evaluated === 0 || errored > 0 || accidentalSkips > 0
        ? 'not-verified'
        : 'pass';

  return {
    schema: QUALITY_RUN_SCHEMA,
    items,
    passed: items.filter((i) => i.status === 'passed').length,
    failed,
    failedWarnings,
    skipped: items.filter((i) => i.status === 'skipped').length,
    errored,
    evaluated,
    verdict,
    ...(input.changedFiles ? { scopedFiles: input.changedFiles.length } : {}),
    failFast: input.failFast,
    diagnostics,
  };
}

/** Map one plane rule result onto a bundle item, with its isolated repro verb. */
function planeItem(plane: string, r: IGateRuleResult, strict: boolean): IQualityItem {
  const notes: string[] = [];
  if (r.status === 'skipped' && r.skipReason) notes.push(`SKIPPED — ${r.skipReason}`);
  if (r.error) notes.push(r.error);
  for (const v of r.violations.slice(0, 5)) {
    const at = v.file ? ` (${v.file}${v.line !== undefined ? `:${v.line}` : ''})` : '';
    notes.push(`${v.id}${at}${v.message ? ` — ${v.message}` : ''}`);
  }
  if (r.violations.length > 5) notes.push(`… ${r.violations.length - 5} more`);
  return {
    id: `${plane}:${r.id}`,
    label: `[${plane}] ${r.id}`,
    status: r.status,
    severity: strict || r.severity === 'error' ? 'error' : 'warning',
    notes,
    // `gates explain` resolves a rule id across EVERY plane, so one form works
    // for all seven and the developer never has to know which verb owns it.
    repro: `shrk gates explain ${r.id}`,
    ...(Object.keys(r.counts).length > 0 ? { data: { ...r.counts } } : {}),
  };
}
