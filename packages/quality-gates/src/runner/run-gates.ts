import {
  detectGraphFreshness,
  GraphStore,
  graphFreshnessBehind,
  graphFreshnessCoverage,
  graphFreshnessRemedy,
  type IGraphFreshness,
} from '@shrkcrft/graph';
import { apiDiffGate, type IApiDiffGateOptions } from '../gates/api-diff-gate.ts';
import { archGate } from '../gates/arch-gate.ts';
import type { IArchGateOptions } from '../schema/arch-gate-options.ts';
import { graphCyclesGate, type IGraphCyclesGateOptions } from '../gates/graph-cycles-gate.ts';
import { graphFreshGate } from '../gates/graph-fresh-gate.ts';
import {
  graphUnresolvedGate,
  type IGraphUnresolvedGateOptions,
} from '../gates/graph-unresolved-gate.ts';
import { impactGate, type IImpactGateOptions } from '../gates/impact-gate.ts';
import {
  impactBaselineGate,
  type IImpactBaselineGateOptions,
} from '../gates/impact-baseline-gate.ts';
import {
  intentClassifierGate,
  type IIntentClassifierGateOptions,
} from '../gates/intent-classifier-gate.ts';
import {
  structuralPatternsGate,
  type IStructuralPatternsGateOptions,
} from '../gates/structural-patterns-gate.ts';
import { wiringGate, type IWiringGateOptions } from '../gates/wiring-gate.ts';
import { policyLintGate, type IPolicyLintGateOptions } from '../gates/policy-lint-gate.ts';
import {
  knowledgeSymbolGate,
  type IKnowledgeSymbolGateOptions,
} from '../gates/knowledge-symbol-gate.ts';
import {
  QUALITY_GATE_SCHEMA,
  type GateStatus,
  type IGateResult,
  type IQualityGateReport,
} from '../schema/quality-gate.ts';

export interface IRunGatesOptions {
  projectRoot: string;
  /** Optional architecture-gate config (baseline-relative toggle). */
  arch?: IArchGateOptions;
  /** Optional impact-gate config (sinceRef, failOn). */
  impact?: IImpactGateOptions;
  /**
   * Optional api-diff gate config. When omitted, the api-diff gate is
   * skipped — the baseline file is what opts a project in.
   */
  apiDiff?: IApiDiffGateOptions;
  /** Optional graph-cycles gate config. */
  graphCycles?: IGraphCyclesGateOptions;
  /** Optional graph-unresolved gate config. */
  graphUnresolved?: IGraphUnresolvedGateOptions;
  /** Optional impact-baseline gate config. */
  impactBaseline?: IImpactBaselineGateOptions;
  /** Optional structural-patterns gate config. */
  structuralPatterns?: IStructuralPatternsGateOptions;
  /** Optional intent-classifier gate config. */
  intentClassifier?: IIntentClassifierGateOptions;
  /** Optional wiring gate config (the project's wiringRules + change scope). */
  wiring?: IWiringGateOptions;
  /** Optional policy-lint gate config (the project's policyRules + change scope). */
  policy?: IPolicyLintGateOptions;
  /**
   * Optional knowledge symbol-ref gate config. When omitted, the gate is
   * skipped — the inspection (async to load) is what opts a project in.
   */
  knowledgeSymbol?: IKnowledgeSymbolGateOptions;
  /** Disable specific gates by id. */
  disable?: readonly string[];
}

/** The gates whose answer is DERIVED from the persisted code-graph index. */
const INDEX_DERIVED_GATES: ReadonlySet<string> = new Set(['arch', 'impact', 'graph-cycles', 'graph-unresolved']);

/**
 * The loud skip of a gate derived from an index behind the working tree: it is
 * not run over the stale input (a cycle count, an arch verdict or a blast
 * radius from it misses real findings and reports fixed ones), and it carries
 * the shared freshness coverage record, so the run settles NOT VERIFIED (2).
 * `undefined` when the index is current (or there is none — each gate reports
 * a missing store itself).
 */
function staleIndexSkip(id: string, label: string, freshness: IGraphFreshness | undefined): IGateResult | undefined {
  if (freshness === undefined) return undefined;
  const coverage = graphFreshnessCoverage(freshness, id);
  if (coverage === undefined) return undefined;
  return {
    id,
    label,
    status: 'skipped',
    message: `Skipped — derived from the code-graph index, which is behind the working tree (${graphFreshnessBehind(freshness)} change(s) since it was built) — NOT VERIFIED.`,
    nextCommands: [graphFreshnessRemedy(freshness)],
    coverage: [coverage],
    durationMs: 0,
  };
}

/**
 * Run the quality-gate aggregator over a project.
 *
 * Default gate set:
 *   - `graph-fresh`: code graph exists + digest matches
 *   - `arch`: architecture-guard checks pass (no errors)
 *   - `impact`: impact-engine risk is below threshold (since `main`)
 *   - `graph-cycles`: surface import cycles (warn on threshold)
 *   - `graph-unresolved`: surface unresolved imports (warn by default)
 *   - `impact-baseline`: skipped unless a baseline is frozen, warn
 *     when worsened since baseline
 *   - `structural-patterns`: skipped unless a registry exists, warn
 *     on any invalid entry
 *   - `intent-classifier`: skipped unless a fixture exists, warn /
 *     fail below the configured accuracy threshold
 *   - `api-diff`: skipped unless options.apiDiff is provided
 *
 * Returns a single structured report with an `overall` status that's
 * `fail` if any gate failed, `warn` if any gate warned, `pass`
 * otherwise.
 */
export function runQualityGates(options: IRunGatesOptions): IQualityGateReport {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const disabled = new Set(options.disable ?? []);
  const diagnostics: string[] = [];
  const gates: IGateResult[] = [];

  // THE freshness answer (`detectGraphFreshness`, the authority `graph status`
  // reads), measured ONCE for graph-fresh and every gate derived from the index
  // (round 11 review R11-GAP-2): a digest-valid store can be behind the tree.
  const wantsIndex = ['graph-fresh', ...INDEX_DERIVED_GATES].some((id) => !disabled.has(id));
  const freshness =
    wantsIndex && new GraphStore(options.projectRoot).exists() ? detectGraphFreshness(options.projectRoot) : undefined;

  // graph-fresh is always first — other gates depend on it.
  if (!disabled.has('graph-fresh')) {
    gates.push(graphFreshGate(options.projectRoot, freshness));
  }
  if (!disabled.has('arch')) {
    gates.push(staleIndexSkip('arch', 'Architecture', freshness) ?? archGate(options.projectRoot, options.arch ?? {}));
  }
  if (!disabled.has('impact')) {
    gates.push(staleIndexSkip('impact', 'Impact', freshness) ?? impactGate(options.projectRoot, options.impact ?? {}));
  }
  if (!disabled.has('graph-cycles')) {
    gates.push(
      staleIndexSkip('graph-cycles', 'Graph cycles', freshness) ??
        graphCyclesGate(options.projectRoot, options.graphCycles ?? {}),
    );
  }
  if (!disabled.has('graph-unresolved')) {
    gates.push(
      staleIndexSkip('graph-unresolved', 'Graph unresolved imports', freshness) ??
        graphUnresolvedGate(options.projectRoot, options.graphUnresolved ?? {}),
    );
  }
  if (!disabled.has('impact-baseline')) {
    gates.push(impactBaselineGate(options.projectRoot, options.impactBaseline ?? {}));
  }
  if (!disabled.has('structural-patterns')) {
    gates.push(structuralPatternsGate(options.projectRoot, options.structuralPatterns ?? {}));
  }
  if (!disabled.has('intent-classifier')) {
    gates.push(intentClassifierGate(options.projectRoot, options.intentClassifier ?? {}));
  }
  if (!disabled.has('wiring')) {
    gates.push(wiringGate(options.projectRoot, options.wiring ?? {}));
  }
  if (!disabled.has('policy')) {
    gates.push(policyLintGate(options.projectRoot, options.policy ?? {}));
  }
  if (!disabled.has('knowledge-symbol') && options.knowledgeSymbol) {
    gates.push(knowledgeSymbolGate(options.projectRoot, options.knowledgeSymbol));
  }
  if (!disabled.has('api-diff') && options.apiDiff) {
    gates.push(apiDiffGate(options.projectRoot, options.apiDiff));
  }

  const counts: Record<GateStatus, number> = { pass: 0, fail: 0, warn: 0, skipped: 0 };
  for (const g of gates) counts[g.status] += 1;
  const overall: GateStatus =
    counts.fail > 0 ? 'fail' : counts.warn > 0 ? 'warn' : counts.pass > 0 ? 'pass' : 'skipped';

  return {
    schema: QUALITY_GATE_SCHEMA,
    overall,
    startedAt,
    totalDurationMs: Date.now() - start,
    counts,
    gates,
    diagnostics,
  };
}
