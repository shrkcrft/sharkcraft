import type { IVerdictCoverage } from '@shrkcrft/core';
import type { IKnowledgeStaleGateRule } from './knowledge-stale-gate-rule.ts';

/**
 * The knowledge stale-check verdict INPUTS, before settling: a proposed exit,
 * the run coverage (entries examined of entries in scope) and the rules.
 * `shrk knowledge stale-check` settles them with `buildGateEnvelope`; `shrk
 * quality` and `buildQualityReport` (MCP, the dashboard, the report site) with
 * `settleKnowledgeStaleGate` — the same numbers either way.
 */
export interface IKnowledgeStaleGate {
  /** 0 / 1 / 2 from what was found — settle it; never return it raw. */
  readonly proposed: number;
  /** Why `proposed` is 1: each blocking condition, in order. */
  readonly reasons: readonly string[];
  readonly requiredStale: number;
  readonly requiredMissing: number;
  /** The envelope rules (`knowledge-references`, `knowledge-files`), or none for an empty scope. */
  readonly rules: readonly IKnowledgeStaleGateRule[];
  /** Knowledge entries examined (verified + stale) of entries in scope. */
  readonly runCoverage: IVerdictCoverage;
  /** True when 0 entries loaded because discovery / config failed — `--allow-empty` never clears that. */
  readonly discoveryFailed: boolean;
  /** One-line explanation for a not-verified verdict, when there is a better one than the shortfall. */
  readonly notVerifiedLead?: string;
  /**
   * Round 13: failing (stale / missing) references this mode WAIVED — blocking
   * nothing, printed as an acceptance (`knowledge-references`'
   * `unitAcceptance`). The ✓ sentence names them instead of claiming "no stale
   * or missing references".
   */
  readonly waived: number;
}
