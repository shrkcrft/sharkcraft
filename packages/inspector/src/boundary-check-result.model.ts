import type { IVerdictCoverage } from '@shrkcrft/core';
import type {
  IBoundaryDeadUnit,
  IBoundaryUnitFinding,
  IBoundarySuppressedViolation,
  IBoundaryViolation,
  IEvaluateResult,
  IImportScanResult,
} from '@shrkcrft/boundaries';
import type { ChangedScopeMode } from './boundaries-changed-only.ts';
import type { IBoundaryConfigurationStatus } from './boundary-configuration-status.model.ts';
import type { IBoundaryLoadIssue } from './boundary-load-issue.model.ts';
import type { IBoundaryRuleCheck } from './boundary-rule-check.model.ts';
import type { IBoundaryRuleInvalidation } from './boundary-rule-invalidation.model.ts';
import type { IBoundaryStaleExceptionFinding } from './boundary-stale-exception-finding.model.ts';

/**
 * The ONE boundary-check answer (round 11, C#one-boundary-check-authority):
 * `check boundaries`, finish's boundaries gate, `diff-check` and both MCP
 * boundary tools read this, so the alias map, the escalation, the exemptions
 * and the verdict cannot differ between them.
 */
export interface IBoundaryCheckResult {
  readonly schema: 'sharkcraft.boundary-check/v1';
  readonly projectRoot: string;
  readonly ruleSource: { readonly kind: 'registry' } | { readonly kind: 'rule-file'; readonly path: string };
  /** Rules in the source (registry or rule file), before `--rule`. */
  readonly rulesConfigured: number;
  /** Rules this run is accountable for: after `--rule`, and in changed mode the governing + escalated ones. */
  readonly selectedRuleIds: readonly string[];
  readonly scan: IImportScanResult;
  /** The full evaluation over the whole scan (always — escalation and stale exceptions need it). */
  readonly evaluation: IEvaluateResult;
  readonly rules: readonly IBoundaryRuleCheck[];
  /** Reported violations (in changed mode: introduced by the changeset or by an escalated rule). */
  readonly violations: readonly IBoundaryViolation[];
  readonly counts: { readonly error: number; readonly warning: number; readonly info: number };
  readonly suppressed: readonly IBoundarySuppressedViolation[];
  readonly staleExceptions: readonly IBoundaryStaleExceptionFinding[];
  /** The selected rules' UNMARKED dead selector units — each rule's settled `.dead`. */
  readonly deadUnits: readonly IBoundaryDeadUnit[];
  /**
   * Units marked `{ pattern, expectEmpty: true }` whose target does not exist
   * (round 13): accepted — printed `accepted by expectEmpty: …` at exit 0 —
   * and never a failure, under any flag.
   */
  readonly intendedEmpty: readonly IBoundaryUnitFinding[];
  /**
   * Units marked `expectEmpty` whose target now exists (round 13): the fence
   * went live and the marker is stale. ✓ withheld; fails only under
   * `--fail-on-dead-units` / `--strict`, and never for a pack marker (INFO).
   */
  readonly wentLive: readonly IBoundaryUnitFinding[];
  /** The units that fail THIS run — core's `selectorUnitFails` under the run's flags. */
  readonly failingUnits: readonly IBoundaryUnitFinding[];
  readonly loadIssues: readonly IBoundaryLoadIssue[];
  readonly configuration?: IBoundaryConfigurationStatus;
  readonly changed?: {
    readonly mode: ChangedScopeMode;
    readonly changedFiles: readonly string[];
    /** Changed SOURCE files (present in the scan) that at least one rule governs. */
    readonly governedFiles: readonly string[];
    readonly ignoredLegacyCount: number;
    readonly ignoredLegacyByRule: Readonly<Record<string, number>>;
    readonly escalation: IBoundaryRuleInvalidation;
    /** Rules escalated in this run (empty under `--no-rule-escalation`). */
    readonly escalatedRuleIds: readonly string[];
    /** Rules that needed escalation but `--no-rule-escalation` kept out — reported unexamined. */
    readonly escalationSuppressed: readonly string[];
  };
  /** Run coverage: rules examined of rules selected. */
  readonly runCoverage: IVerdictCoverage;
  /** The exit this run proposes before settling on coverage (the CLI envelope takes this). */
  readonly proposedExit: number;
  /** Settled with core's shortfall rule — never 0 over an unexamined scope. */
  readonly exitCode: number;
  readonly verdict: 'pass' | 'fail' | 'not-verified' | 'usage-error';
  readonly shortfalls: readonly string[];
  /**
   * The settled acceptances (`<rule>: accepted by expectEmpty: …`) — present
   * only at exit 0, like every acceptance (core `settleVerdict`). Round 13.
   */
  readonly accepted: readonly string[];
  /** Set when `--rule` named no rule (exit 3). */
  readonly unknownRuleId?: string;
  readonly availableRuleIds?: readonly string[];
}
