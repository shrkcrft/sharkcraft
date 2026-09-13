import { readFileSync } from 'node:fs';
import {
  buildUniversalSearch,
  classifyQueryIntent,
  countsTowardConfidence,
  describeSuppression,
  entrypointBanner,
  inspectSharkcraft,
  pickNextCommand,
  rankRecommendationCandidates,
  recommendationReportFromRanking,
  RECOMMEND_SOURCE_FLOORS,
  RecommendationSource,
  renderUncertaintyReportText,
  type ICommandRecommendation,
  type ICommandRecommendationReport,
  type IQueryIntentResult,
  type IRecommendationCandidate,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagNumber,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { ExitCode } from '../exit-codes.ts';
import { asJson } from '../output/format-output.ts';
import { loadSurfaceContext } from '../surface/load-surface-context.ts';
import { catalogCommandSafety } from '../surface/catalog-command-safety.ts';
import { dropNotApplicable, notApplicableHere, surfaceViewForCommand } from '../surface/audience-applicability.ts';
import { buildSurfaceSummary } from '../surface/surface-summary.ts';

/**
 * `shrk recommend` renders THE ranked list (`rankRecommendationCandidates`,
 * inspector). It used to re-rank it: a CLI-only grounding prepend, a
 * routing-hint "R1" promotion gated on create/build wording, and a separate
 * "engine match" block — three code paths answering "what do I run first?",
 * each with its own thresholds, none reachable from MCP or `shrk context`.
 * Now every row, its attribution, `nextCommand`, the confidence and the
 * coverage-gap verdict come from the one list; the CLI only gates rows by
 * surface tier and re-picks `nextCommand` over what it renders, by THE rule.
 */
export const recommendCommand: ICommandHandler = {
  name: 'recommend',
  description:
    'Recommend commands based on a free-form query, role, or stderr blob. Deterministic — no AI.',
  usage:
    'shrk recommend "<what I want to do>" [--from-error <stderr-file>] [--role developer|reviewer|architect|release-manager|security|ai-agent] [--min-score <n>] [--require-confident] [--verbose] [--json]',
  booleanFlags: new Set([
    'json',
    'machine-json',
    'verbose',
    'full',
    'include-gated',
    'commands-first',
    'actions-only',
    'require-confident',
  ]),
  async run(args: ParsedArgs): Promise<number> {
    const query = args.positional.join(' ').trim();
    const fromErrorFile = flagString(args, 'from-error');
    let fromError = '';
    if (fromErrorFile) {
      try {
        fromError = readFileSync(fromErrorFile, 'utf8');
      } catch (err) {
        process.stderr.write(
          `Failed to read --from-error file: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        return 1;
      }
    }
    if (!query && !fromError) {
      process.stderr.write('Usage: shrk recommend "<query>" or --from-error <file>\n');
      return 2;
    }
    let minScore: number | undefined;
    if (args.flags.has('min-score')) {
      minScore = flagNumber(args, 'min-score');
      if (minScore === undefined || !(minScore > 0)) {
        process.stderr.write(
          `--min-score takes a number > 0 (the floor multiplier; 1 = each source's own floor), got "${String(args.flags.get('min-score'))}".\n`,
        );
        return ExitCode.UsageError;
      }
    }
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const role = flagString(args, 'role');
    const ranked = await rankRecommendationCandidates(inspection, query || fromError, {
      ...(fromError ? { fromError } : {}),
      ...(minScore !== undefined ? { minScore } : {}),
      // THE declared safety (the command catalog) — labels and withholds a
      // writer by what its row declares, never by the fallback regex.
      safetyOf: (command) => catalogCommandSafety(command),
    });
    const reportRaw = recommendationReportFromRanking(ranked, role ? { role } : {});
    // Gate by surface tier. Recommendations whose underlying command is
    // experimental + not enabled get moved to a "gated" bucket with an
    // enable hint. Callable ones stay in `recommendations`.
    const { context: surfaceContext } = await loadSurfaceContext({ cwd, inspection });
    const surface = buildSurfaceSummary(surfaceContext);
    const includeGated = flagBool(args, 'include-gated');
    const { keep, gated, notApplicable } = partitionByCallable(reportRaw.recommendations, surface, includeGated);
    // `nextCommand` is re-picked over the rows actually rendered — by THE rule,
    // so it is row 1 whenever the answer is confident.
    // THE audience filter (`dropNotApplicable`, shared with `shrk context`)
    // reaches every row this command prints or emits — the ranked list and the
    // uncertainty block's suggested commands (a recipe may name `release
    // readiness`), not only the recommendations — and re-picks `nextCommand`
    // over the rows actually rendered, by THE rule.
    const report: ICommandRecommendationReport = dropNotApplicable({ ...reportRaw, recommendations: keep }, surface);
    const requireConfident = flagBool(args, 'require-confident');
    // `recommend` is not a gate: 0 by default. `--require-confident` makes "no
    // confident match" a branchable 2 (ran, proved nothing); global `--strict`
    // then promotes it to 1.
    const exit = requireConfident && !report.confident ? ExitCode.NotVerified : ExitCode.VerifiedPass;
    const actionsOnly = flagBool(args, 'actions-only');
    const machineJson = flagBool(args, 'json') || flagBool(args, 'machine-json');

    if (machineJson) {
      let searchReport: Awaited<ReturnType<typeof buildUniversalSearch>> | null = null;
      if (query.length > 0) {
        try {
          searchReport = await buildUniversalSearch(inspection, query, {});
        } catch {
          searchReport = null;
        }
      }
      process.stdout.write(
        asJson({
          ...report,
          routingMatches: ranked.routingMatches,
          search: searchReport,
          gated,
          ...(notApplicable.length > 0 ? { notApplicable } : {}),
          rankerMatch: ranked.rankerTop,
          ...(requireConfident ? { exitCode: exit } : {}),
        }) + '\n',
      );
      return exit;
    }

    const write = (s: string): void => {
      process.stdout.write(s);
    };
    // Default human output: verdict + top 3 commands + next command +
    // details flag. `--verbose` / `--full` brings back the long form.
    const verbose = flagBool(args, 'verbose') || flagBool(args, 'full');
    const topN = flagNumber(args, 'top') ?? (verbose ? report.recommendations.length : 3);
    const visibleRecs = report.recommendations.slice(0, topN);
    const suppressed = report.ranked.filter((c) => c.suppressedReason !== undefined);
    if (!actionsOnly) {
      // Entrypoint banner: promote shrk recommend as the human entrypoint.
      write(`(${entrypointBanner('recommend')})\n\n`);
      if (report.confident) {
        write(`=== Recommended commands (top ${visibleRecs.length}) ===\n`);
      } else {
        write(`=== ${noConfidentHeadline(report)} ===\n`);
        if (visibleRecs.length > 0) write('Weak candidates (not routed — verify before acting):\n');
      }
      for (const r of visibleRecs) write(renderRow(r, report.confident, verbose));
      if (report.recommendations.length > visibleRecs.length) {
        write(`  … (${report.recommendations.length - visibleRecs.length} more — pass --verbose to see all)\n`);
      }
      write(renderSuppressed(suppressed, ranked.intent, verbose));
    }
    if (ranked.routingMatches.length > 0 && !actionsOnly && verbose) {
      const hintFloor = RECOMMEND_SOURCE_FLOORS[RecommendationSource.RoutingHint];
      write('\nRouting hints:\n');
      for (const m of ranked.routingMatches.slice(0, 5)) {
        write(`  • ${m.hint.id}  (score ${m.score}, floor ${hintFloor} → ${(m.score / hintFloor).toFixed(2)})  ${m.hint.title}\n`);
        if (m.reasons.length > 0) write(`      matched: ${m.reasons.join(', ')}\n`);
        const commands = m.hint.recommends?.commands ?? [];
        write(`      commands: ${commands.length > 0 ? commands.join(' · ') : '(none — this hint recommends no command)'}\n`);
      }
    }
    // Coverage gap — exactly when nothing cleared its floor (THE confidence
    // verdict). It used to key on "no routing hint fired", so any weak spurious
    // hint hid it, and a strong one never lifted the verdict.
    if (!report.confident && query.length > 0) {
      write(
        `\n⚠ Coverage gap — nothing matched "${query}" with confidence (no routing hint, recipe or template cleared its floor).\n` +
          `  Suggest:\n` +
          `    shrk coverage scaffolds --task "${query}"\n` +
          `    shrk feedback actions\n` +
          `    (or contribute a pack template / helper / routing hint)\n`,
      );
    }
    if (gated.length > 0 && !actionsOnly) {
      write(`\nGated (experimental, not enabled in this repo):\n`);
      for (const g of gated.slice(0, 3)) {
        write(`  $ ${g.command}  — ${g.why}\n`);
        write(`      Enable: shrk surface enable ${g.viewCommand} --write\n`);
      }
      if (gated.length > 3) {
        write(`  … (${gated.length - 3} more — pass --include-gated --json to inspect)\n`);
      }
    }
    write(`\nNext command:\n  $ ${report.nextCommand}\n`);
    if (!actionsOnly && verbose) {
      write('\n' + renderUncertaintyReportText(report.uncertainty) + '\n');
    } else if (!actionsOnly) {
      // Built from THE confidence authority only — never a second label.
      const u = report.uncertainty;
      const issues = u.missingSignals.length + u.conflictingSignals.length;
      if (issues > 0) {
        write(`\nUncertainty: ${u.confidence} confidence, ${issues} signal(s) — pass --verbose for the full report.\n`);
      }
    }
    if (requireConfident && !report.confident) {
      write('\n(--require-confident: no confident match — exit 2)\n');
    }
    return exit;
  },
};

/** "No confident match (best 0.67 of floor 1.00 — routing hint "x" (score 2, floor 3))". */
function noConfidentHeadline(report: ICommandRecommendationReport): string {
  const best = report.ranked.find((c) => !c.suppressedReason && countsTowardConfidence(c.source));
  const floor = report.floor.toFixed(2);
  if (!best) {
    return report.ranked.some((c) => countsTowardConfidence(c.source))
      ? `No confident match (every matching candidate was suppressed; floor ${floor})`
      : `No confident match (nothing matched; floor ${floor})`;
  }
  return `No confident match (best ${report.bestScore.toFixed(2)} of floor ${floor} — ${best.attribution})`;
}

function renderRow(r: ICommandRecommendation, confident: boolean, verbose: boolean): string {
  // `?` marks a weak candidate — below its floor, or nothing is confident.
  const mark = !confident || r.weak === true ? '?' : '$';
  const attribution = r.attribution ?? r.why;
  if (!verbose) return `  ${mark} ${r.command}  [${r.safetyLevel}] — ${attribution}\n`;
  let out = `  ${mark} ${r.command}\n    why: ${r.why}\n    source: ${attribution}${r.weak ? ' — weak (below the floor)' : ''}\n    safety: ${r.safetyLevel}\n`;
  if (r.docsLink) out += `    docs: ${r.docsLink}\n`;
  return out;
}

/** Suppressed candidates are never silent: one line by default, every one under --verbose. */
function renderSuppressed(
  suppressed: readonly IRecommendationCandidate[],
  intent: IQueryIntentResult,
  verbose: boolean,
): string {
  if (suppressed.length === 0) return '';
  if (verbose) {
    let out = `\nSuppressed (${suppressed.length}):\n`;
    for (const c of suppressed) {
      out += `  ✗ ${c.command}  [${c.safetyLevel}] — ${c.attribution}: ${describeSuppression(c, intent)}\n`;
    }
    return out;
  }
  const first = suppressed[0]!;
  const more = suppressed.length > 1 ? `; +${suppressed.length - 1} more` : '';
  return `  (${suppressed.length} suppressed: ${first.command} — ${describeSuppression(first, intent)}${more}; --verbose)\n`;
}

interface IGatedRecommendation {
  command: string;
  viewCommand: string;
  why: string;
  enableHint: string;
}

interface IRawRecommendation {
  command: string;
  why?: string;
}

/**
 * Partition recommender output by whether the underlying CLI command is
 * callable in this project's surface. Gated commands (experimental +
 * not in `surface.enabled[]`) are moved to a separate bucket the
 * renderer surfaces with an enable hint. Callable commands (core,
 * extended, or already-enabled experimental) stay in `keep`.
 *
 * The match strategy: extract the first 1-2 tokens after `shrk` from
 * `command`. Try the full path then the top-level token (mirrors the
 * resolver's behavior in main.ts).
 */
function partitionByCallable<T extends IRawRecommendation>(
  recs: readonly T[],
  summary: ReturnType<typeof buildSurfaceSummary>,
  includeGated: boolean,
): { keep: T[]; gated: IGatedRecommendation[]; notApplicable: string[] } {
  const keep: T[] = [];
  const gated: IGatedRecommendation[] = [];
  const notApplicable: string[] = [];
  for (const r of recs) {
    const view = surfaceViewForCommand(r.command, summary);
    if (!view || view.callable) {
      keep.push(r);
      continue;
    }
    // A tool-maintenance command outside SharkCraft's own repository (THE host
    // authority behind the surface gate) is not "experimental, not enabled": it
    // does not apply here, and enabling it would run SharkCraft's own docs /
    // release contract on this repository. Never recommended, never offered an
    // `Enable:` hint — only listed, in `--json`, as not applicable.
    if (notApplicableHere(r.command, summary)) {
      notApplicable.push(r.command);
      continue;
    }
    if (includeGated) keep.push(r);
    gated.push({
      command: r.command,
      viewCommand: view.command,
      why: r.why ?? '',
      enableHint: `shrk surface enable ${view.command} --write`,
    });
  }
  return { keep, gated, notApplicable };
}

// The surface-view lookup and the audience rule live in
// `surface/audience-applicability.ts` — one authority for `recommend` and
// `context`.

/**
 * DX#2 — does the query read like planning (a planning verb leading the query
 * or in slots 1–3)? A thin wrapper over THE query-intent classifier
 * (`classifyQueryIntent`, inspector), kept for its callers; the planning verb
 * set lives there now.
 */
export function looksLikePlanning(query: string): boolean {
  return classifyQueryIntent(query).planVerb !== undefined;
}

/**
 * Does the query read like create/build work? A thin wrapper over THE
 * query-intent classifier — which now also refuses a create word used as a
 * noun or adjective in a repair query ("fix the broken build").
 */
export function looksLikeCreateBuild(query: string): boolean {
  return classifyQueryIntent(query).createVerb !== undefined;
}
