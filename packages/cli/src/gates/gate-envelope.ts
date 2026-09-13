/**
 * One machine-readable shape for every gate verb.
 *
 * `--json` has always been available on each plane, but each emitted its own
 * schema (`sharkcraft.wiring/v1`, `sharkcraft.baseline/v1`, …), so a CI step or
 * agent had to parse four shapes to answer one question: which rules ran, which
 * failed, and why. This envelope is that answer, identical across planes.
 *
 * It is ADDITIVE. The per-plane payloads are published, documented, and asserted
 * by tests; replacing them would break every existing consumer. The envelope
 * rides along under a `gate` key, so `jq .gate` is the uniform read and nothing
 * that worked before stops working.
 */
import {
  coverageShortfall,
  ruleAcceptedAsIntendedEmpty,
  ruleVerdictRecords,
  settleRuleStatus,
  type IUnitStateLists,
  type IVerdictCoverage,
} from '@shrkcrft/core';
import { settleVerdict } from './settle-verdict.ts';
import type { ISettledVerdict } from './settled-verdict.ts';

export const GATE_ENVELOPE_SCHEMA = 'sharkcraft.gate/v1' as const;

/** Which data-defined plane (or verdict surface) produced a rule result. */
export type GateRuleType =
  | 'wiring'
  | 'policy'
  | 'registry'
  | 'registration'
  | 'baseline'
  | 'generated'
  | 'doc-reference'
  | 'boundary'
  | 'knowledge'
  | 'lifecycle'
  | 'orphans'
  | 'finish'
  | 'quality'
  | 'diff'
  | 'reuse'
  /** `conventions check` (round 13): one row per loaded convention, plus the convention-file load record. */
  | 'convention';

/**
 * Per-rule outcome, uniform across planes. `skipped` is deliberately a
 * first-class status, not folded into `passed` — a rule that matched nothing
 * enforced nothing.
 *
 * `partial` is derived by {@link buildGateEnvelope} and ONLY there: a rule its
 * producer reported `passed` whose coverage has a shortfall. It found nothing
 * wrong in what it examined, and it did not examine everything it was asked
 * to — so it is not a pass, and the envelope's exit is never `0` over it.
 */
export type GateRuleStatus = 'passed' | 'partial' | 'failed' | 'skipped' | 'error';

/** One violation, normalized. `id` is the offending token / entry / file. */
export interface IGateViolation {
  readonly id: string;
  readonly file?: string;
  readonly line?: number;
  readonly message?: string;
  readonly hint?: string;
}

/** One rule's result in the shared envelope. */
export interface IGateRuleResult {
  readonly id: string;
  readonly type: GateRuleType;
  readonly status: GateRuleStatus;
  readonly severity: 'error' | 'warning';
  /**
   * Plane-appropriate match counts — e.g. `{declared, registered}` for wiring,
   * `{committed, current}` for baseline, `{units, findings}` for policy. Always
   * present so "what did this rule actually see?" is answerable uniformly.
   */
  readonly counts: Readonly<Record<string, number>>;
  readonly violations: readonly IGateViolation[];
  /** Why the rule checked nothing, when `status` is `skipped`. */
  readonly skipReason?: string;
  /** Set when the rule is misconfigured (`status: 'error'`). */
  readonly error?: string;
  /**
   * What this rule examined against what it was asked to. REQUIRED: a producer
   * cannot omit it (tsc fails), so no plane can report a clean rule over an
   * unexamined scope by forgetting a check — the envelope builder compares the
   * two for every rule, whoever produced it.
   */
  readonly coverage: IVerdictCoverage;
  /**
   * The rule's `expectEmpty` ACCEPTANCE — settle record B
   * (`settleUnitLiveness(...).acceptance`, `@shrkcrft/core`): the units the rule
   * asserts are intended-empty. {@link buildGateEnvelope} folds it into the ONE
   * `settleVerdict` call beside {@link coverage} (once, when the two are the
   * same record — `ruleVerdictRecords`), so it reaches `accepted` at exit 0 and
   * is never dropped. It never changes the rule's status: `partial` is derived
   * from {@link coverage} alone. Optional and additive (round 13).
   */
  readonly unitAcceptance?: IVerdictCoverage;
  /**
   * The rule's non-live selector units, each as its `formatUnitLiveness` line
   * (built by `unitStateLists`, `@shrkcrft/core`). Optional and additive:
   * present only on a plane that settles units; passed through unchanged.
   */
  readonly units?: IUnitStateLists;
  /** The rule's coverage shortfall. Derived by {@link buildGateEnvelope}; a producer's value is ignored. */
  readonly shortfall?: string;
}

/** The envelope emitted under the `gate` key of every gate verb's `--json`. */
export interface IGateEnvelope {
  readonly schema: typeof GATE_ENVELOPE_SCHEMA;
  /** The verb that produced this, space-joined (e.g. `check wiring`). */
  readonly verb: string;
  /**
   * The exit code this run returns — the same number the process exits with.
   * Settled: never `0` while {@link shortfalls} is non-empty.
   */
  readonly exit: number;
  /** `pass` / `fail` / `not-verified` / `usage-error` — {@link exit} in words. */
  readonly verdict: ISettledVerdict['verdict'];
  /**
   * Rules that ran a real comparison (status neither `skipped` nor `error`;
   * `partial` counts). A rule ACCEPTED as intended-empty (round 13, K6 — its
   * coverage IS its `expectEmpty` acceptance: every inclusion unit of its
   * primary list marked, 0 files examined; `ruleAcceptedAsIntendedEmpty`) is
   * never counted here: it is counted in {@link acceptedEmpty}.
   */
  readonly evaluated: number;
  /**
   * Rules accepted as intended-empty (round 13, K6) — they examined 0 files
   * by design, so they are counted apart from {@link evaluated} and printed
   * `N evaluated, M accepted as intended-empty`. OPTIONAL: present only when
   * non-zero, so the envelope gains no always-present key.
   */
  readonly acceptedEmpty?: number;
  readonly skipped: number;
  readonly failed: number;
  /** Rules that passed over a partially-examined scope. */
  readonly partial: number;
  /** Run-level coverage — e.g. rules examined of rules selected. */
  readonly coverage: IVerdictCoverage;
  /** Every scope gap that vetoes a clean verdict: the run's, then each rule's (prefixed `<id>: `). */
  readonly shortfalls: readonly string[];
  /**
   * Gaps an explicit acceptance waived (`--allow-empty`, `registeredExtras`, a
   * rule's `expectEmpty` units via `rules[].unitAcceptance`) — printed, never
   * silent; non-empty only at exit 0.
   */
  readonly accepted: readonly string[];
  readonly rules: readonly IGateRuleResult[];
}

/**
 * Build the envelope from already-normalized per-rule results — and SETTLE the
 * exit while doing it.
 *
 * The caller proposes an exit from what it found; the builder compares every
 * rule's coverage (and the run's) to what was requested, marks a `passed` rule
 * with a shortfall `partial`, and runs the proposal through `settleVerdict`. So
 * `gate.exit` can never be `0` over an unexamined scope, whichever verb built
 * it. `runCoverage` is required for the same reason `IGateRuleResult.coverage`
 * is: an envelope that could omit it would be the hole this closes.
 *
 * Settle first, render second: build this unconditionally (text AND JSON),
 * return `env.exit`, and print the final line through `verdictLine(env, …)`.
 */
export function buildGateEnvelope(
  verb: string,
  proposedExit: number,
  rules: readonly IGateRuleResult[],
  runCoverage: IVerdictCoverage,
): IGateEnvelope {
  const settledRules: IGateRuleResult[] = rules.map((r) => {
    const shortfall = coverageShortfall(r.coverage);
    const { shortfall: _producerShortfall, ...rest } = r;
    return {
      ...rest,
      // The ONE `partial` derivation (core) — the wiring explain engine calls
      // the same function, so `gates explain` cannot disagree with this.
      status: settleRuleStatus(r.status, r.coverage),
      ...(shortfall !== undefined ? { shortfall } : {}),
    };
  });
  // Each rule contributes its primary coverage AND its expectEmpty acceptance
  // (settle record B), folded once by the ONE rule shared with the boundary
  // orchestrator (`ruleVerdictRecords`): an acceptance reaches `accepted` — at
  // exit 0 only, as settleVerdict decides — and is never dropped. `partial`
  // above reads the primary record alone.
  const settled = settleVerdict(proposedExit, [
    runCoverage,
    ...rules.flatMap((r) =>
      ruleVerdictRecords(r.coverage, r.unitAcceptance).map((c) => ({ ...c, subject: c.subject ?? r.id })),
    ),
  ]);
  // THE K6 partition (round 13): of the rules that ran (neither skipped nor
  // errored), one whose coverage IS its `expectEmpty` acceptance examined 0
  // files by design — ACCEPTED, never evaluated. One predicate (core's
  // `ruleAcceptedAsIntendedEmpty`) over the record the engines' own settle put
  // on the rule, so no verb re-derives it.
  const ran = settledRules.filter((r) => r.status !== 'skipped' && r.status !== 'error');
  const acceptedEmpty = ran.filter((r) => ruleAcceptedAsIntendedEmpty(r)).length;
  return {
    schema: GATE_ENVELOPE_SCHEMA,
    verb,
    exit: settled.exit,
    verdict: settled.verdict,
    evaluated: ran.length - acceptedEmpty,
    // Optional: present only when non-zero — never an always-present key.
    ...(acceptedEmpty > 0 ? { acceptedEmpty } : {}),
    skipped: settledRules.filter((r) => r.status === 'skipped').length,
    failed: settledRules.filter((r) => r.status === 'failed' || r.status === 'error').length,
    partial: settledRules.filter((r) => r.status === 'partial').length,
    coverage: runCoverage,
    shortfalls: settled.shortfalls,
    accepted: settled.accepted,
    rules: settledRules,
  };
}
