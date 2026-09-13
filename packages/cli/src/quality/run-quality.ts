import { withFileReadCache, withLexCache } from '@shrkcrft/boundaries';
import { DEAD_SELECTOR_CAUSES, formatUnitLiveness, type IVerdictCoverage } from '@shrkcrft/core';
import type { IQualityConfig, IQualityGateResult, ISharkcraftInspection } from '@shrkcrft/inspector';
import {
  buildQualityReport,
  examineQualityGate,
  KNOWLEDGE_STALE_GATE_ID,
  QualityGateExamination,
} from '@shrkcrft/inspector';
import { warmCliReferenceRegistries } from '../surface/cli-command-resolver.ts';
import { ExitCode } from '../exit-codes.ts';
import { GATE_PLANES, type GatePlane, type IGateRuleView } from '../gates/gate-rule-view.ts';
import { runGatePlanes } from '../gates/run-gate-planes.ts';
import { buildGateEnvelope, type IGateRuleResult } from '../gates/gate-envelope.ts';
import { settleVerdict } from '../gates/settle-verdict.ts';
import {
  buildGateCoverage,
  coverageDeadUnits,
  coverageWentLiveUnits,
  formatDeadUnits,
  reportsDeadGlobs,
  settleGateCoverage,
  withRejectedRules,
} from '../gates/rule-coverage.ts';

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
   * True when the gate RAN but examined only part of its scope (a plane rule
   * the envelope settled `partial`, or an inspector gate reporting
   * `data.partial`). Its status is `skipped` (accidental, so never a pass);
   * this flag names it PARTIAL instead of SKIP in every rendering.
   */
  readonly partial?: boolean;
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
  /** The settled exit — never `0` while {@link shortfalls} is non-empty. */
  readonly exit: number;
  /**
   * Gates examined of gates the run was asked to check. A DELIBERATE skip (out
   * of the changeset, stopped by `--fail-fast`, an optional gate with nothing
   * to examine) is excluded from `expected`; an accidental one (an error, a
   * required gate that examined nothing, a rule that passed over part of its
   * scope) is an unexamined unit.
   */
  readonly coverage: IVerdictCoverage;
  /** The scope gaps that kept the verdict off `pass` (empty on a clean run). */
  readonly shortfalls: readonly string[];
  /**
   * Gaps an explicit acceptance waived — on a passing run only (an acceptance
   * is a statement about a CLEAN verdict). Round 15: the knowledge item's own
   * (`knowledgeCheck.minReferenced`, a `required: false` waiver), each
   * `knowledge-stale: <line>` — the pass stood on a waived gap while this read
   * `[]`, so a JSON consumer had to parse the item's notes to see it.
   */
  readonly accepted: readonly string[];
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
  /**
   * Pack rules the merge seam rejected (`seamRejectedRules`, the rows `gates
   * check` fails on) — configured rules that never ran. Each is a FAILED item
   * and an errored coverage row, never out of the count (round 12 review, R12-X1).
   */
  readonly rejectedRules?: readonly (IGateRuleResult & { readonly type: GatePlane })[];
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
  // Round 13: the item is `buildDeclaredXrefReport` — exactly what `self-config
  // xrefs` prints. `self-config doctor` computes a different report (dead
  // units, probes, rejections), so on a tree with no declared id the item
  // said "skipped — none declared" while its repro exited 2 over dead units.
  'cross-references': 'shrk self-config xrefs',
});

/** At most this many unexamined gate ids ride on the run's coverage record. */
const COVERAGE_LABEL_CAP = 20;

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

  // Warm the shared reference registry WITH the command resolver BEFORE any
  // bundle gate reads it. The agent-test gate resolves `expectedCommands`
  // through it: warmed bare (the inspector cannot build the command index), a
  // correct `shrk doctor` read as NOT VERIFIED here while `shrk test agent`
  // passed it — the aggregate and the verb disagreeing about one test.
  try {
    await warmCliReferenceRegistries(input.inspection);
  } catch (e) {
    diagnostics.push(`could not warm the reference registries: ${(e as Error).message}`);
  }

  const report = await buildQualityReport({
    inspection: input.inspection,
    config: input.config,
    strict: input.strict,
    ...(input.changedFiles ? { changedFiles: input.changedFiles } : {}),
    // This bundle runs the seven planes below, so the report must not add its
    // not-run `gate-planes` row.
    callerRunsGatePlanes: true,
  });
  // The knowledge stale-check row is THE gate MCP / the dashboard read too; it
  // becomes this bundle's item after the fail-fast check below, as before.
  let knowledgeGate: IQualityGateResult | undefined;
  for (const g of report.gates) {
    if (g.id === KNOWLEDGE_STALE_GATE_ID) {
      knowledgeGate = g;
      continue;
    }
    // A gate that ran over NOTHING (zero context tests, zero boundary rules)
    // reports `passed` from a zero failure count, which is not a pass. It is a
    // skip: DELIBERATE when the gate is optional (so a repo without context
    // tests still goes green), accidental — NOT verified — when it is required.
    // THE classification of a gate's run (`examineQualityGate`), the same one
    // the inspector derives `IQualityReport.overall` from, so MCP / the
    // dashboard and this bundle cannot disagree about a gate. A gate that ran
    // over NOTHING (zero context tests, zero boundary rules) is a skip:
    // deliberate when optional, NOT verified when required. A gate that found
    // nothing wrong over PART of its scope is an accidental skip too.
    const exam = examineQualityGate(g);
    const examinedNothing = g.executed && g.data?.['examinedNothing'] === true;
    const partial = g.executed && !examinedNothing && exam === QualityGateExamination.Unexamined;
    const status: QualityItemStatus = !g.executed
      ? 'error'
      : exam !== QualityGateExamination.Examined
        ? 'skipped'
        : g.passed
          ? 'passed'
          : 'failed';
    items.push({
      id: g.id,
      label: g.label,
      status,
      severity: g.blocking ? 'error' : 'warning',
      notes: examinedNothing
        ? [
            ...g.notes,
            g.blocking
              ? 'examined nothing — this gate is required, so it is NOT verified'
              : 'examined nothing — optional, so skipped (never counted as a pass)',
          ]
        : g.notes,
      repro: INSPECTOR_REPRO[g.id] ?? 'shrk quality',
      ...(examinedNothing ? { skippedDeliberately: !g.blocking } : {}),
      ...(partial && !examinedNothing ? { partial: true } : {}),
      ...(g.data ? { data: g.data } : {}),
    });
  }

  const stopNow = (): boolean =>
    input.failFast && items.some((i) => i.status === 'failed' && i.severity === 'error');

  // The knowledge corpus verdict, through the SAME gate `shrk knowledge
  // stale-check` settles — so the pre-push bundle and the verb cannot disagree
  // (an unverifiable entry keeps both off `pass`) — read from the report's own
  // row, the one MCP `get_quality_report` and the dashboard read.
  if (!stopNow() && knowledgeGate) items.push(knowledgeStaleItem(knowledgeGate));

  // The seven data-defined planes. Without them the "before you push" command
  // does not run the rules the repo actually declared, which is the gap that
  // makes `gates check` a separate step people forget.
  // A pack rule the merge seam rejected is a configured rule that did NOT run:
  // a FAILED item (a config failure blocks, as in `gates check`), and an
  // errored row of the coverage item (round 12 review, R12-X1).
  const rejectedRules = input.rejectedRules ?? [];
  const rejectedKeys = new Set(rejectedRules.map((r) => `${r.type}:${r.id}`));
  const hasPlaneRules = input.gateRules.length > 0 || rejectedRules.length > 0;
  if (hasPlaneRules && !stopNow()) {
    // ONE lex window and ONE read window around the plane check AND the
    // coverage pass (round 11 review: the coverage item re-walked, re-read and
    // re-lexed every file the plane run had just read — ~0.4s on this repo).
    // The lex memo is keyed by CONTENT, so it can never be stale; the read memo
    // is exact because every spawn site (`compute.run`, `regen`) clears it
    // right after the child exits.
    withLexCache(() =>
      withFileReadCache(() => {
        const planeRun =
          input.gateRules.length > 0
            ? runGatePlanes(input.gateRules, {
                cwd: input.cwd,
                excludeDirs: input.excludeDirs,
                ...(input.changedFiles ? { changedFiles: input.changedFiles } : {}),
                inspection: input.inspection,
              })
            : { results: [], diagnostics: [] };
        diagnostics.push(...planeRun.diagnostics);
        const results: IGateRuleResult[] = [...planeRun.results, ...rejectedRules];
        // `partial` is derived in ONE place — the envelope builder — so quality
        // marks a rule partial exactly when `gates check` does.
        const settledRules = buildGateEnvelope('quality', ExitCode.VerifiedPass, results, {
          unit: 'rules',
          expected: results.length,
          examined: results.length,
        }).rules;
        for (const plane of GATE_PLANES) {
          for (const r of settledRules.filter((x) => x.type === plane)) {
            const item = planeItem(plane, r, input.strict);
            items.push(
              rejectedKeys.has(`${plane}:${r.id}`)
                ? { ...item, status: 'failed', severity: 'error', repro: 'shrk packs contributions' }
                : item,
            );
          }
        }
        // The stale-selector detector and every rule's selfTest — what `gates
        // coverage` concludes. Without it "the before-you-push gate" passed a
        // rule whose selfTest was broken, because only `gates coverage`
        // evaluates one.
        items.push(stopNow() ? coverageNotRun() : gatesCoverageItem(input, results));
      }),
    );
  } else if (hasPlaneRules) {
    for (const r of rejectedRules) {
      items.push({
        id: `${r.type}:${r.id}`,
        label: `[${r.type}] ${r.id}`,
        status: 'failed',
        severity: 'error',
        notes: [r.error ?? 'failed validation at the pack-plane merge seam — NOT evaluated'],
        repro: 'shrk packs contributions',
      });
    }
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
    items.push(coverageNotRun());
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
  const evaluated = items.filter((i) => i.status === 'passed' || i.status === 'failed').length;
  const deliberate = items.filter(
    (i) => i.status === 'skipped' && i.skippedDeliberately === true,
  ).length;
  const unexamined = items.filter(
    (i) => i.status === 'error' || (i.status === 'skipped' && i.skippedDeliberately !== true),
  );
  // The verdict goes through the one guard every verdict verb uses: a blocking
  // failure is `fail`; otherwise any gate that errored, skipped by accident or
  // passed over part of its scope — or a run that examined nothing at all — is
  // a coverage shortfall, which can never settle to `pass`.
  const coverage: IVerdictCoverage = {
    unit: 'gates',
    expected: items.length - deliberate,
    examined: evaluated,
    ...(unexamined.length > 0
      ? {
          unexamined: unexamined.slice(0, COVERAGE_LABEL_CAP).map((i) => i.id),
          unexaminedTotal: unexamined.length,
          reason: unexamined.some((i) => i.partial === true)
            ? 'could not run, examined nothing, or examined only part of their scope'
            : 'could not run, or examined nothing',
        }
      : {}),
  };
  const settled = settleVerdict(failed > 0 ? ExitCode.Failure : ExitCode.VerifiedPass, [coverage]);
  const verdict: IQualityRun['verdict'] =
    settled.verdict === 'pass' ? 'pass' : settled.verdict === 'not-verified' ? 'not-verified' : 'fail';
  // The knowledge item's acceptance rides into the run's `accepted` (round 15)
  // — only over a passing run, the one `settleVerdict` rule.
  const knowledgeItem = items.find((i) => i.id === KNOWLEDGE_STALE_GATE_ID && i.status === 'passed');
  const knowledgeAccepted =
    settled.exit === ExitCode.VerifiedPass && Array.isArray(knowledgeItem?.data?.['accepted'])
      ? (knowledgeItem.data['accepted'] as readonly unknown[])
          .filter((a): a is string => typeof a === 'string')
          .map((a) => `${KNOWLEDGE_STALE_GATE_ID}: ${a}`)
      : [];

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
    exit: settled.exit,
    coverage,
    shortfalls: settled.shortfalls,
    accepted: [...settled.accepted, ...knowledgeAccepted],
    ...(input.changedFiles ? { scopedFiles: input.changedFiles.length } : {}),
    failFast: input.failFast,
    diagnostics,
  };
}

const COVERAGE_ITEM_ID = 'gates-coverage';
const COVERAGE_ITEM_LABEL = 'Gate-rule coverage — stale selectors + selfTest';

/**
 * `gates coverage` as one bundle item: stale selectors, every rule's selfTest,
 * partial rules. Settled by `settleGateCoverage` — the derivation the verb
 * itself uses — so this item and `shrk gates coverage` cannot disagree. Dead
 * globs inside connected rules ride along as advisory notes, exactly as they
 * are advisory in the verb without `--fail-on-dead-units`.
 *
 * A rule coverage cannot inspect without a side effect (`inspectable: false`,
 * e.g. a `command` baseline with no `watchFiles`) is settled on the coverage
 * its plane CHECK reported in this same run. That check spawned the command and
 * examined it. Reading coverage's "could not inspect" as "unverified" would
 * leave a healthy rule a permanent `2`, with this item and the rule's own plane
 * item contradicting each other about one rule. A selfTest such a rule can
 * never evaluate stays a misconfiguration (`1`): its status is untouched.
 */
function gatesCoverageItem(input: IRunQualityInput, planeResults: readonly IGateRuleResult[]): IQualityItem {
  // Rules arrive with `$use` already resolved; the shared-extractor section of
  // the report is not read here, so no extractor map is needed.
  const built = withRejectedRules(
    buildGateCoverage(input.cwd, input.gateRules, input.excludeDirs, {}, false, input.inspection),
    input.rejectedRules ?? [],
  );
  const checked = new Map(planeResults.map((r) => [`${r.type}:${r.id}`, r.coverage]));
  const settledOnCheck: string[] = [];
  const report = {
    ...built,
    rules: built.rules.map((r) => {
      const fromCheck = r.inspectable === false ? checked.get(`${r.plane}:${r.id}`) : undefined;
      if (!fromCheck) return r;
      settledOnCheck.push(`[${r.plane}] ${r.id}`);
      return { ...r, coverage: fromCheck };
    }),
  };
  const env = settleGateCoverage(report);
  const notes: string[] = [];
  const noticed = new Set<string>();
  // A rule its own negations emptied is not stale — its skipReason says why.
  const emptiedByNegations = new Set(
    report.rules.filter((r) => r.excludedByNegations !== undefined).map((r) => `${r.plane}:${r.id}`),
  );
  for (const r of env.rules) {
    if (r.status === 'passed') continue;
    noticed.add(r.id);
    const lead = `[${r.type}] ${r.id}`;
    if (r.status === 'partial') {
      notes.push(`${lead} — PARTIAL: ${r.shortfall ?? 'examined less than its scope'}`);
    } else if (r.status === 'skipped') {
      notes.push(
        `${lead} — ${r.skipReason ?? 'matched nothing'}` +
          (emptiedByNegations.has(`${r.type}:${r.id}`) ? '' : '; the selector is probably stale'),
      );
    } else if (r.status === 'error') {
      notes.push(`${lead} — ${r.error ?? 'could not run'}`);
    } else if (r.violations.length > 0) {
      for (const v of r.violations) notes.push(`${lead} — selfTest: ${v.message ?? v.id}`);
    } else {
      notes.push(`${lead} — ${r.skipReason ?? 'failed'}`);
    }
  }
  for (const r of report.rules) {
    // The same predicate `gates coverage` counts and draws with: a rule already
    // reported as matching nothing gets no second, advisory note.
    if (!reportsDeadGlobs(r)) continue;
    // Worded by the one formatter `gates coverage` prints with, so a dead
    // negation reads "excludes nothing", never "matched 0 files".
    const dead = coverageDeadUnits(r);
    // …with the one causes sentence (round 13 review): a note has no footer,
    // so it carries `DEAD_SELECTOR_CAUSES` itself, as `check boundaries` does.
    notes.push(
      `[${r.plane}] ${r.id} — advisory: ${dead.length} dead glob(s): ${formatDeadUnits(dead)} — ${DEAD_SELECTOR_CAUSES}`,
    );
  }
  // Round 13 (lane G): a glob marked `expectEmpty` whose target now exists —
  // the fence went live — is an ADVISORY note here, worded by the one
  // per-unit formatter; quality never fails on a selector unit (`gates
  // coverage --fail-on-dead-units` does, for a local marker). A PACK marker is
  // INFO (round 13 review), as `check boundaries` prints it.
  for (const r of report.rules) {
    for (const u of coverageWentLiveUnits(r)) {
      const tag = u.mark?.packageName !== undefined ? 'info' : 'advisory';
      notes.push(`[${r.plane}] ${r.id} — ${tag}: ${formatUnitLiveness(u, { causes: false })}`);
    }
  }
  // …and every intended-empty unit it ACCEPTED is printed, never silent — the
  // settled acceptance lines (non-empty only when the item passed).
  for (const a of env.accepted) notes.push(`accepted: ${a}`);
  for (const label of settledOnCheck) {
    notes.push(
      `${label} — coverage cannot inspect it without running it; settled on its plane check in this run`,
    );
  }
  return {
    id: COVERAGE_ITEM_ID,
    label: COVERAGE_ITEM_LABEL,
    status:
      env.exit === ExitCode.Failure ? 'failed' : env.exit === ExitCode.VerifiedPass ? 'passed' : 'skipped',
    // A broken selfTest blocks whatever --strict says, as it does in the verb.
    severity: 'error',
    notes,
    repro: noticed.size > 0 ? `shrk gates coverage --only ${[...noticed].join(',')}` : 'shrk gates coverage',
    data: {
      rules: report.total,
      empty: report.empty,
      errored: report.errored,
      expectationFailures: report.expectationFailures,
      deadGlobs: report.deadGlobCount,
    },
  };
}

/** The coverage item when `--fail-fast` stopped the run before it. */
function coverageNotRun(): IQualityItem {
  return {
    id: COVERAGE_ITEM_ID,
    label: COVERAGE_ITEM_LABEL,
    status: 'skipped',
    severity: 'warning',
    notes: ['not run — an earlier gate failed under --fail-fast'],
    repro: 'shrk gates coverage',
    skippedDeliberately: true,
  };
}

/** Map one plane rule result onto a bundle item, with its isolated repro verb. */
function planeItem(plane: string, r: IGateRuleResult, strict: boolean): IQualityItem {
  const notes: string[] = [];
  if (r.status === 'skipped' && r.skipReason) notes.push(`SKIPPED — ${r.skipReason}`);
  // A rule that passed over PART of its scope proved nothing about the rest, so
  // here it is an accidental skip: the verdict cannot be `pass` over it.
  if (r.status === 'partial' && r.shortfall) notes.push(`PARTIAL — ${r.shortfall}`);
  if (r.error) notes.push(r.error);
  for (const v of r.violations.slice(0, 5)) {
    const at = v.file ? ` (${v.file}${v.line !== undefined ? `:${v.line}` : ''})` : '';
    notes.push(`${v.id}${at}${v.message ? ` — ${v.message}` : ''}`);
  }
  if (r.violations.length > 5) notes.push(`… ${r.violations.length - 5} more`);
  return {
    id: `${plane}:${r.id}`,
    label: `[${plane}] ${r.id}`,
    status: r.status === 'partial' ? 'skipped' : r.status,
    ...(r.status === 'partial' ? { partial: true } : {}),
    severity: strict || r.severity === 'error' ? 'error' : 'warning',
    notes,
    // `gates explain` resolves a rule id across EVERY plane, so one form works
    // for all seven and the developer never has to know which verb owns it.
    repro: `shrk gates explain ${r.id}`,
    ...(Object.keys(r.counts).length > 0 ? { data: { ...r.counts } } : {}),
  };
}

/**
 * The knowledge stale-check as one bundle item — the report's own
 * `knowledge-stale` row (`knowledgeStaleQualityGate`, decided by the SAME gate
 * the verb settles), mapped onto the item shape. Nothing is re-derived here, so
 * this item, MCP `get_quality_report` and the dashboard read one answer.
 *
 * An empty corpus (or a changeset no entry references) is a DELIBERATE skip —
 * a missing `sharkcraft/` folder or a broken config is the doctor gate's
 * finding. Any unverifiable entry that no `knowledgeCheck.minReferenced` floor
 * accepts is an ACCIDENTAL skip: the run cannot settle to `pass` over it.
 */
function knowledgeStaleItem(g: IQualityGateResult): IQualityItem {
  const base = {
    id: g.id,
    label: g.label,
    severity: 'error' as const,
    repro: 'shrk knowledge stale-check',
  };
  const skip = g.data?.['skip'];
  if (skip === 'empty-corpus') {
    return { ...base, status: 'skipped', notes: g.notes, skippedDeliberately: true, data: { examinedNothing: true } };
  }
  if (skip === 'out-of-changeset') {
    return {
      ...base,
      status: 'skipped',
      notes: g.notes,
      repro: 'shrk knowledge stale-check --changed-only',
      skippedDeliberately: true,
    };
  }
  if (!g.executed) return { ...base, status: 'error', notes: g.notes };
  const exit = g.data?.['settledExit'];
  return {
    ...base,
    status: exit === ExitCode.VerifiedPass ? 'passed' : exit === ExitCode.Failure ? 'failed' : 'skipped',
    notes: g.notes,
    ...(exit === ExitCode.NotVerified ? { skippedDeliberately: false } : {}),
    data: {
      coverage: g.data?.['coverage'],
      unverifiableIds: g.data?.['unverifiableIds'],
      // Round 15 follow-up (F3): entries the loader refused — never checked.
      rejectedEntries: g.data?.['rejectedEntries'] ?? [],
      failureCounts: g.data?.['failureCounts'],
      // What an explicit valve accepted (round 15) — hoisted into the run's `accepted`.
      accepted: g.data?.['accepted'] ?? [],
    },
  };
}
