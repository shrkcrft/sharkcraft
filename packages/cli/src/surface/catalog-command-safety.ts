import { CommandResolutionStatus, type ICommandSafety } from '@shrkcrft/inspector';
import { COMMAND_CATALOG, SafetyLevel, type ICommandCatalogEntry } from '../commands/command-catalog.ts';
import { buildCommandIndex, findCommandIndexEntry, getActiveCommandIndex } from './command-index.ts';
import type { ICommandIndex } from './i-command-index.ts';
import { resolveCommandString } from './resolve-command-string.ts';

/** Most to least dangerous — the most dangerous applicable catalog row wins. */
const SAFETY_RANK: Readonly<Record<string, number>> = {
  [SafetyLevel.ReadOnly]: 0,
  [SafetyLevel.WritesSessionOnly]: 1,
  [SafetyLevel.WritesDraftsOnly]: 2,
  [SafetyLevel.RunsShell]: 3,
  [SafetyLevel.WritesSource]: 4,
};

let catalogByCommand: ReadonlyMap<string, ICommandCatalogEntry> | undefined;
let fallbackIndex: ICommandIndex | undefined;

/**
 * THE declared safety of a command string, from COMMAND_CATALOG — what the
 * CLI injects into the recommendation ranker (`IRecommendationRankingOptions
 * .safetyOf`), so a recommended command is labelled and withheld by what its
 * catalog row DECLARES, never by a regex guess.
 *
 * The string is resolved through THE command resolver (`resolveCommandString`
 * over the command index). The base row of the matched path applies, plus any
 * flag-variant row whose flags the string carries (`check wiring --fix` over
 * `check wiring`); the most dangerous row wins. `writesSource` is the catalog
 * audit's own predicate: `writesSource || safetyLevel === writes-source`.
 * `undefined` for a string the catalog does not document (the ranker then
 * falls back to the regex).
 */
export function catalogCommandSafety(raw: string, index?: ICommandIndex): ICommandSafety | undefined {
  const idx = index ?? getActiveCommandIndex() ?? (fallbackIndex ??= buildCommandIndex());
  const resolution = resolveCommandString(idx, raw);
  if (
    resolution.matched === undefined ||
    (resolution.status !== CommandResolutionStatus.Ok && resolution.status !== CommandResolutionStatus.PrefixOnly)
  ) {
    return undefined;
  }
  const entry = findCommandIndexEntry(idx, resolution.matched);
  if (!entry?.catalogEntry) return undefined;
  catalogByCommand ??= new Map(COMMAND_CATALOG.map((e) => [e.command, e]));
  const tokens = new Set(raw.trim().split(/\s+/).map((t) => t.split('=')[0]!));
  const rows: ICommandCatalogEntry[] = [entry.catalogEntry];
  for (const variant of entry.variants) {
    const flags = variant
      .split(/\s+/)
      .slice(entry.tokens.length)
      .filter((t) => t.startsWith('--'));
    if (flags.length === 0 || !flags.every((f) => tokens.has(f))) continue;
    const row = catalogByCommand.get(variant);
    if (row) rows.push(row);
  }
  let level = entry.catalogEntry.safetyLevel;
  let writesSource = false;
  for (const row of rows) {
    if ((SAFETY_RANK[row.safetyLevel] ?? 0) > (SAFETY_RANK[level] ?? 0)) level = row.safetyLevel;
    if (row.writesSource === true || row.safetyLevel === SafetyLevel.WritesSource) writesSource = true;
  }
  return { safetyLevel: level as ICommandSafety['safetyLevel'], writesSource };
}
