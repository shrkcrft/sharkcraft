import { summarizeImports } from '@shrkcrft/boundaries';
import {
  boundaryRulesAcceptedEmpty,
  boundaryRulesEvaluated,
  boundarySkippedRuleRows,
  runBoundaryCheck,
} from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

/**
 * Read-only MCP tool: check_boundaries.
 *
 * Round 11: through THE boundary orchestrator (`runBoundaryCheck`) — the call
 * `shrk check boundaries` makes. This tool used to hand-assemble scan +
 * evaluate WITHOUT the tsconfig alias map, so a violation the CLI reported
 * through an alias was invisible here. It now carries the same verdict
 * (pass / fail / not-verified / usage-error), coverage, errored rules and
 * dead units as the CLI. Never writes; never loads a rule file by path (that
 * would execute it).
 *
 * Round 13: `failOnDeadUnits` is the CLI's `--fail-on-dead-units` (an agent
 * can finally ask for that reading), and the output carries every
 * `expectEmpty` unit's state — `intendedEmpty` (accepted), `wentLive` (a stale
 * marker), `failingUnits` — and the settled `accepted` lines. A rule accepted
 * as intended-empty examined 0 files: it is counted in `rulesAcceptedEmpty`,
 * never in `rulesEvaluated` (K6) — the `check boundaries --json` keys.
 */
export const checkBoundariesTool: IToolDefinition = {
  name: 'check_boundaries',
  description:
    'Scan the project imports and evaluate every configured boundary rule (tsconfig aliases resolved) — the same engine as `shrk check boundaries`. Returns violations, counts, per-rule coverage (each selector unit with its state), errored rules, dead selector units, expectEmpty units that are intended-empty (accepted) or went live (a stale marker: the fence now has a target), the units that fail this run, the `accepted` lines, the import-graph summary and a verdict (pass | fail | not-verified | usage-error) with its exit code. `failOnDeadUnits: true` = `--fail-on-dead-units`: a dead unit, or a local expectEmpty marker that went live, fails the run (a pack marker never does). Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      ruleId: { type: 'string', description: 'Optional: evaluate only one rule by id.' },
      failOnDeadUnits: {
        type: 'boolean',
        description:
          'Like `shrk check boundaries --fail-on-dead-units`: a dead selector unit, or a local expectEmpty marker that went live, fails the run (exitCode 1). A pack marker that went live never fails.',
      },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const { ruleId, failOnDeadUnits } = input as { ruleId?: unknown; failOnDeadUnits?: unknown };
    const r = runBoundaryCheck(ctx.inspection, {
      ...(typeof ruleId === 'string' ? { onlyRuleId: ruleId } : {}),
      ...(failOnDeadUnits === true ? { failOnDeadUnits: true } : {}),
    });
    const verdict = {
      verdict: r.verdict,
      exitCode: r.exitCode,
      shortfalls: r.shortfalls,
      runCoverage: r.runCoverage,
    };
    if (r.unknownRuleId !== undefined) {
      return {
        data: {
          error: 'unknown-rule',
          ruleId: r.unknownRuleId,
          available: r.availableRuleIds ?? [],
          ...verdict,
        },
      };
    }
    if (r.rulesConfigured === 0 && r.loadIssues.length === 0) {
      // Zero rules is NOT a clean check — nothing was examined.
      return {
        data: {
          rulesEvaluated: 0,
          rulesAcceptedEmpty: 0,
          violations: [],
          counts: { error: 0, warning: 0, info: 0 },
          note: 'no boundary rules configured',
          ...(r.configuration ? { configuration: r.configuration } : {}),
          ...verdict,
        },
      };
    }
    return {
      data: {
        rulesConfigured: r.rulesConfigured,
        // "Evaluated" / "skipped" through THE predicate `check boundaries
        // --json` reads (`boundaryRuleCheckedNothing`): a failOnEmpty rule is
        // `failed` in `rules[].status` yet examined nothing, and a rule whose
        // governed files went unread is PARTIAL — never "checked nothing".
        rulesEvaluated: boundaryRulesEvaluated(r),
        // Round 13 (K6): rules accepted as intended-empty (every `from`
        // inclusion marked `expectEmpty`, no file matched) examined 0 files —
        // counted apart, never in rulesEvaluated; the `check boundaries --json`
        // key, from THE same inspector predicate.
        rulesAcceptedEmpty: boundaryRulesAcceptedEmpty(r).length,
        edgesEvaluated: r.scan.edges.length,
        counts: r.counts,
        violations: r.violations,
        suppressed: r.suppressed,
        staleExceptions: r.staleExceptions,
        skipped: boundarySkippedRuleRows(r),
        unreadFiles: r.scan.unread ?? [],
        deadUnits: r.deadUnits,
        intendedEmpty: r.intendedEmpty,
        wentLive: r.wentLive,
        failingUnits: r.failingUnits,
        loadIssues: r.loadIssues,
        coverage: r.rules.map((x) => x.detail),
        importGraph: summarizeImports(r.scan),
        ...verdict,
        accepted: r.accepted,
      },
    };
  },
};
