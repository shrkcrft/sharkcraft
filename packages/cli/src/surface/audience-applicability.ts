import { pickNextCommand, type ICommandRecommendationReport } from '@shrkcrft/inspector';
import { findCommandInSummary, type buildSurfaceSummary, type ISurfaceCommandView } from './surface-summary.ts';
import { TierSource } from './tier.ts';

type SurfaceSummary = ReturnType<typeof buildSurfaceSummary>;

/**
 * The surface view a recommended command string names: its first one or two
 * command words after an optional `$` / `bun run` / `shrk` (the full path
 * first, then the top-level token).
 */
export function surfaceViewForCommand(rawCommand: string, summary: SurfaceSummary): ISurfaceCommandView | undefined {
  const tokens = rawCommand.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return undefined;
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
  return findCommandInSummary(summary, verbTokens.join(' ')) ?? findCommandInSummary(summary, verbTokens[0]!);
}

/**
 * A command that maintains SharkCraft itself, asked about outside SharkCraft's
 * own repository: gated by AUDIENCE (exit 78), so it is no recommendation here
 * at all — not "experimental, not enabled", and never an `Enable:` hint.
 * Read off THE surface view (`source` is `tool-maintenance` only outside the
 * tool repo), never a second host check.
 */
export function notApplicableHere(command: string, summary: SurfaceSummary): boolean {
  const view = surfaceViewForCommand(command, summary);
  return view !== undefined && !view.callable && view.source === TierSource.ToolMaintenance;
}

/**
 * THE audience filter over a recommender report, for every surface that prints
 * one (`shrk recommend`, `shrk context`'s "Top commands"): the rows, the ranked
 * list and the uncertainty block's suggested commands lose every command that
 * does not apply here, and `nextCommand` is re-picked by THE rule.
 */
export function dropNotApplicable(report: ICommandRecommendationReport, summary: SurfaceSummary): ICommandRecommendationReport {
  const applicable = (command: string): boolean => !notApplicableHere(command, summary);
  const recommendations = report.recommendations.filter((r) => applicable(r.command));
  return {
    ...report,
    recommendations,
    ranked: report.ranked.filter((c) => applicable(c.command)),
    uncertainty: { ...report.uncertainty, suggestedCommands: report.uncertainty.suggestedCommands.filter(applicable) },
    nextCommand: pickNextCommand(recommendations, report.confident),
  };
}
