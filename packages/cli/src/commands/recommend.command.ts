import { readFileSync } from 'node:fs';
import {
  buildUniversalSearch,
  entrypointBanner,
  explainTaskRouting,
  inspectSharkcraft,
  recommendCommands,
  renderUncertaintyReportText,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagNumber,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson } from '../output/format-output.ts';
import { loadSurfaceContext } from '../surface/load-surface-context.ts';
import {
  buildSurfaceSummary,
  findCommandInSummary,
  type ISurfaceCommandView,
} from '../surface/surface-summary.ts';

export const recommendCommand: ICommandHandler = {
  name: 'recommend',
  description:
    'Recommend commands based on a free-form query, role, or stderr blob. Deterministic — no AI.',
  usage:
    'shrk recommend "<what I want to do>" [--from-error <stderr-file>] [--role developer|reviewer|architect|release-manager|security|ai-agent] [--json]',
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
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const role = flagString(args, 'role');
    const reportRaw = await recommendCommands(inspection, query || fromError, {
      ...(fromError ? { fromError } : {}),
      ...(role ? { role } : {}),
    });
    // DX#2 — when the task text looks like a planning thread (planning
    // verb at the start, or a "plan/design/review for X" shape), prepend
    // `shrk grounding "<task>"` as the top recommendation. The existing
    // recommender output slides down. Pure-text classifier; no LLM.
    if (query.length > 0 && looksLikePlanning(query)) {
      const groundingRec = {
        command: `shrk grounding "${query.replace(/"/g, '\\"')}" --json`,
        why: 'DX#2: query looks like planning — start with grounding (task-relevant rules / knowledge / templates / verification IDs) before picking a write verb.',
        safetyLevel: 'read-only' as const,
      };
      // Avoid duplicating if the recommender already surfaced grounding.
      const alreadyHasGrounding = reportRaw.recommendations.some((r) =>
        r.command.startsWith('shrk grounding') || r.command.startsWith('bun run shrk grounding'),
      );
      if (!alreadyHasGrounding) {
        (reportRaw as { recommendations: typeof reportRaw.recommendations }).recommendations = [
          groundingRec,
          ...reportRaw.recommendations,
        ];
      }
    }
    // Gate by surface tier. Recommendations whose underlying command is
    // experimental + not enabled get moved to a "gated" bucket with an
    // enable hint. Callable ones stay in `recommendations`.
    const { context: surfaceContext } = await loadSurfaceContext({ cwd, inspection });
    const surface = buildSurfaceSummary(surfaceContext);
    const includeGated = flagBool(args, 'include-gated');
    const { keep, gated } = partitionByCallable(reportRaw.recommendations, surface, includeGated);
    const report = { ...reportRaw, recommendations: keep };
    // Combine recommender output with routing hints + universal search.
    const wantsCommandsFirst = flagBool(args, 'commands-first');
    const actionsOnly = flagBool(args, 'actions-only');
    const machineJson = flagBool(args, 'json') || flagBool(args, 'machine-json');
    let routingMatches: Awaited<ReturnType<typeof explainTaskRouting>> = [];
    let searchReport: Awaited<ReturnType<typeof buildUniversalSearch>> | null = null;
    if (query.length > 0) {
      try {
        routingMatches = await explainTaskRouting(inspection, query);
      } catch {
        // ignore
      }
      try {
        searchReport = await buildUniversalSearch(inspection, query, {});
      } catch {
        searchReport = null;
      }
    }
    // R1 — promote a strongly-matched task-routing hint's recommends.commands
    // into the HEADLINE for create/build intents. Routing hints are scored by
    // explainTaskRouting but were previously only shown under --verbose, so the
    // headline fell back to generic review/report/impact commands even when the
    // pack declared the right `shrk gen <template>` playbook. When the top hint
    // clears the threshold AND the query looks like create/build work, its
    // commands lead and the generic defaults slide to the tail. Deterministic.
    const topHint = routingMatches[0];
    const hintCommands = topHint?.hint.recommends.commands ?? [];
    if (
      query.length > 0 &&
      looksLikeCreateBuild(query) &&
      topHint &&
      topHint.score >= ROUTING_HINT_PROMOTE_THRESHOLD &&
      hintCommands.length > 0
    ) {
      const promoted = hintCommands.map((command) => ({
        command,
        why: `Routing hint "${topHint.hint.id}" matched (score ${topHint.score}) — project playbook for this create/build task.`,
        safetyLevel: promotedSafetyLevel(command),
      }));
      const promotedSet = new Set(promoted.map((p) => p.command));
      const isGenericDefault = (c: string): boolean =>
        /^(bun run )?shrk (review|report|impact)\b/i.test(c);
      const existing = report.recommendations;
      const keptNonGeneric = existing.filter(
        (r) => !promotedSet.has(r.command) && !isGenericDefault(r.command),
      );
      const keptGeneric = existing.filter(
        (r) => !promotedSet.has(r.command) && isGenericDefault(r.command),
      );
      (report as { recommendations: typeof report.recommendations }).recommendations = [
        ...promoted,
        ...keptNonGeneric,
        ...keptGeneric,
      ];
    }
    if (machineJson) {
      process.stdout.write(
        asJson({
          ...report,
          routingMatches,
          search: searchReport,
          gated,
        }) + '\n',
      );
      return 0;
    }
    // Default human output: verdict + top 3 commands + next command +
    // details flag. `--verbose` / `--full` brings back the long form.
    const verbose = flagBool(args, 'verbose') || flagBool(args, 'full');
    const topN = flagNumber(args, 'top') ?? (verbose ? report.recommendations.length : 3);
    const visibleRecs = report.recommendations.slice(0, topN);
    if (!actionsOnly) {
      // Entrypoint banner: promote shrk recommend as the human entrypoint.
      process.stdout.write(`(${entrypointBanner('recommend')})\n\n`);
      process.stdout.write(`=== Recommended commands (top ${visibleRecs.length}) ===\n`);
      for (const r of visibleRecs) {
        if (verbose) {
          process.stdout.write(`  $ ${r.command}\n    why: ${r.why}\n    safety: ${r.safetyLevel}\n`);
          if (r.docsLink) process.stdout.write(`    docs: ${r.docsLink}\n`);
        } else {
          process.stdout.write(`  $ ${r.command}  [${r.safetyLevel}] — ${r.why}\n`);
        }
      }
      if (report.recommendations.length > visibleRecs.length) {
        process.stdout.write(
          `  … (${report.recommendations.length - visibleRecs.length} more — pass --verbose to see all)\n`,
        );
      }
    }
    if (routingMatches.length > 0 && !actionsOnly && verbose) {
      process.stdout.write('\nRouting hints:\n');
      for (const m of routingMatches.slice(0, 5)) {
        process.stdout.write(`  • ${m.hint.id}  (score=${m.score})  ${m.hint.title}\n`);
      }
    }
    if (searchReport && !actionsOnly && verbose) {
      const top = (searchReport.sections.bestActions ?? []).slice(0, 5);
      if (top.length > 0) {
        process.stdout.write('\nBest actions (from universal search):\n');
        for (const a of top) {
          const action = (a as { action?: string; command?: string }).action ?? (a as { command?: string }).command;
          if (action) process.stdout.write(`  • ${action}\n`);
        }
      }
    }
    // Coverage gap — explicit if recommendations look thin and no routing hint fired.
    if (
      report.recommendations.length <= 1 &&
      routingMatches.length === 0 &&
      query.length > 0
    ) {
      process.stdout.write(
        `\n⚠ Coverage gap — no recipe, no routing hint, and no helper/template matched "${query}".\n` +
        `  Suggest:\n` +
        `    shrk coverage scaffolds --task "${query}"\n` +
        `    shrk feedback actions\n` +
        `    (or contribute a pack template / helper / routing hint)\n`,
      );
    }
    if (gated.length > 0 && !actionsOnly) {
      process.stdout.write(`\nGated (experimental, not enabled in this repo):\n`);
      for (const g of gated.slice(0, 3)) {
        process.stdout.write(`  $ ${g.command}  — ${g.why}\n`);
        process.stdout.write(`      Enable: shrk surface enable ${g.viewCommand} --write\n`);
      }
      if (gated.length > 3) {
        process.stdout.write(`  … (${gated.length - 3} more — pass --include-gated --json to inspect)\n`);
      }
    }
    process.stdout.write(`\nNext command:\n  $ ${report.nextCommand}\n`);
    if (!actionsOnly && verbose) {
      process.stdout.write('\n' + renderUncertaintyReportText(report.uncertainty) + '\n');
    } else if (!actionsOnly) {
      // Tighten the default — show count + one-liner pointer to detail.
      const u = report.uncertainty;
      const issues = u.missingSignals.length + u.conflictingSignals.length;
      if (issues > 0) {
        process.stdout.write(
          `\nUncertainty: ${u.confidence} confidence, ${issues} signal(s) — pass --verbose for the full report.\n`,
        );
      }
    }
    if (wantsCommandsFirst) {
      // commands-first formatting was the default — nothing more to do.
    }
    return 0;
  },
};

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
): { keep: T[]; gated: IGatedRecommendation[] } {
  const keep: T[] = [];
  const gated: IGatedRecommendation[] = [];
  for (const r of recs) {
    const view = resolveView(r.command, summary);
    if (!view || view.callable) {
      keep.push(r);
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
  return { keep, gated };
}

function resolveView(
  rawCommand: string,
  summary: ReturnType<typeof buildSurfaceSummary>,
): ISurfaceCommandView | undefined {
  const tokens = rawCommand.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return undefined;
  // Drop leading `shrk` / `bun run shrk` / `$`
  let i = 0;
  if (tokens[i] === '$') i += 1;
  if (tokens[i] === 'bun' && tokens[i + 1] === 'run') i += 2;
  if (tokens[i] === 'shrk') i += 1;
  const verbTokens: string[] = [];
  for (let j = i; j < tokens.length; j += 1) {
    const t = tokens[j]!;
    if (t.startsWith('-') || t.startsWith('<') || t.startsWith('"')) break;
    verbTokens.push(t);
    if (verbTokens.length >= 2) break;
  }
  if (verbTokens.length === 0) return undefined;
  const fullPath = verbTokens.join(' ');
  return findCommandInSummary(summary, fullPath) ?? findCommandInSummary(summary, verbTokens[0]!);
}

/**
 * DX#2 — detect "planning" intent in a task string.
 *
 * Triggers on:
 *   - a leading verb from the planning set (plan/design/review/audit/…)
 *   - the same verb appearing in "plan for X" / "design X" patterns
 *
 * Pure heuristic. No LLM. Conservative — false negatives are fine
 * (the original ranker still fires); false positives just push an extra
 * read-only suggestion that the user can ignore.
 */
const PLANNING_VERBS: ReadonlySet<string> = new Set([
  'plan',
  'design',
  'propose',
  'review',
  'audit',
  'analyze',
  'analyse',
  'explore',
  'consider',
  'investigate',
  'survey',
  'compare',
  'evaluate',
  'assess',
]);

/**
 * Minimum routing-hint score (from `explainTaskRouting`: +2 per keyword, +3 per
 * phrase, +2 per regex, + confidenceBoost) required to promote a hint's
 * commands into the recommend headline. 3 ⇒ at least one phrase match or two
 * keyword/regex hits — a real match, not a single weak keyword.
 */
const ROUTING_HINT_PROMOTE_THRESHOLD = 3;

const CREATE_BUILD_VERBS: ReadonlySet<string> = new Set([
  'create', 'build', 'add', 'generate', 'scaffold', 'implement', 'make', 'new', 'introduce', 'write',
]);

/**
 * Does the query look like create/build work (a routing hint's `shrk gen`
 * playbook is most useful here)? Mirrors {@link looksLikePlanning}: a
 * create/build verb leading the query or in slots 1–3.
 */
export function looksLikeCreateBuild(query: string): boolean {
  const tokens = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return false;
  if (CREATE_BUILD_VERBS.has(tokens[0]!)) return true;
  for (let i = 1; i < Math.min(4, tokens.length); i++) {
    if (CREATE_BUILD_VERBS.has(tokens[i]!)) return true;
  }
  return false;
}

/** Conservative safety classification for a promoted routing-hint command. */
function promotedSafetyLevel(
  command: string,
): 'read-only' | 'writes-source' | 'writes-drafts' | 'runs-shell' {
  if (/^(bun run )?shrk (gen|init|apply|import)\b/i.test(command)) return 'writes-source';
  if (/^(bun run )?shrk (brief|dev|onboard|simulate|orchestrate|spec)\b/i.test(command)) {
    return 'writes-drafts';
  }
  if (/^(bun|bunx|npm|pnpm|node|git|nx) /i.test(command)) return 'runs-shell';
  return 'read-only';
}

export function looksLikePlanning(query: string): boolean {
  const tokens = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return false;
  // Leading verb form: "plan a thing", "design the system".
  if (PLANNING_VERBS.has(tokens[0]!)) return true;
  // "Help me plan X" / "I want to design Y" — verb in slots 1–3.
  for (let i = 1; i < Math.min(4, tokens.length); i++) {
    if (PLANNING_VERBS.has(tokens[i]!)) return true;
  }
  return false;
}
