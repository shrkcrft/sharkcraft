/**
 * Command discovery + did-you-mean.
 *
 * Provides typo-tolerant ranking over a SharkCraft command catalog. Used by
 * `shrk commands suggest <partial>`, `shrk commands explain <cmd>`, and the
 * "Unknown subcommand → did you mean …" path in `runCli`.
 *
 * Pure, deterministic, fixture-friendly.
 *
 * Schema: sharkcraft.command-suggestions/v1
 */

export const COMMAND_SUGGESTIONS_SCHEMA = 'sharkcraft.command-suggestions/v1';

export interface ICommandEntryLike {
  command: string;
  description: string;
  category: string;
  safetyLevel: string;
  writesFiles: boolean;
  writesSource: boolean;
  runsShell: boolean;
  requiresReview: boolean;
  mcpAvailable: boolean;
  aliases: readonly string[];
}

export interface ICommandSuggestion {
  command: string;
  category: string;
  description: string;
  safetyLevel: string;
  score: number;
  reasons: readonly string[];
  /** When true, the suggestion writes to source — useful for --safe-only filtering. */
  writesSource: boolean;
  /** When false, the suggestion can't be invoked via MCP. */
  mcpAvailable: boolean;
}

export interface ICommandSuggestionsOptions {
  /** Cap returned suggestions. Default 10. */
  limit?: number;
  /** Exclude suggestions that write source. */
  safeOnly?: boolean;
  /** Only show MCP-callable commands. */
  mcpSafeOnly?: boolean;
  /** Filter by category. */
  category?: string;
}

function lev(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[] = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) dp[j] = j;
  for (let i = 1; i <= m; i += 1) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const tmp = dp[j]!;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + cost);
      prev = tmp;
    }
  }
  return dp[n]!;
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter((t) => t.length > 0);
}

function unique(arr: readonly string[]): string[] {
  return Array.from(new Set(arr));
}

function bestFuzzyHit(token: string, candidates: readonly string[]): { hit: string | undefined; distance: number } {
  let bestHit: string | undefined;
  let bestDistance = Infinity;
  for (const cand of candidates) {
    if (cand.length === 0) continue;
    // exact substring → distance 0
    if (cand.includes(token) || token.includes(cand)) {
      bestHit = cand;
      bestDistance = 0;
      continue;
    }
    const d = lev(token, cand);
    if (d < bestDistance) {
      bestDistance = d;
      bestHit = cand;
    }
  }
  return { hit: bestHit, distance: bestDistance };
}

function scoreCommandForQuery(
  command: ICommandEntryLike,
  queryTokens: readonly string[],
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const cmdLower = command.command.toLowerCase();
  const cmdTokens = unique([
    ...tokenize(command.command),
    ...command.aliases.flatMap((a) => tokenize(a)),
  ]);
  const descTokens = tokenize(command.description);
  for (const q of queryTokens) {
    const qLower = q.toLowerCase();
    // Exact substring of full command string.
    if (cmdLower.includes(qLower)) {
      score += 10;
      reasons.push(`substring "${qLower}" in command`);
      continue;
    }
    const tokenHit = bestFuzzyHit(qLower, cmdTokens);
    if (tokenHit.hit && tokenHit.distance <= 1) {
      score += tokenHit.distance === 0 ? 8 : 5;
      reasons.push(
        tokenHit.distance === 0
          ? `exact token "${tokenHit.hit}"`
          : `near-match "${tokenHit.hit}" (≈"${qLower}")`,
      );
      continue;
    }
    if (tokenHit.hit && tokenHit.distance <= Math.max(2, Math.floor(qLower.length * 0.4))) {
      score += 3;
      reasons.push(`fuzzy "${tokenHit.hit}" (~"${qLower}")`);
      continue;
    }
    // Description match.
    if (descTokens.includes(qLower)) {
      score += 2;
      reasons.push(`description contains "${qLower}"`);
      continue;
    }
    const descHit = bestFuzzyHit(qLower, descTokens);
    if (descHit.hit && descHit.distance <= 1) {
      score += 1;
      reasons.push(`description near-match "${descHit.hit}"`);
    }
  }
  return { score, reasons };
}

export function suggestCommands(
  catalog: readonly ICommandEntryLike[],
  partial: string,
  options: ICommandSuggestionsOptions = {},
): {
  schema: typeof COMMAND_SUGGESTIONS_SCHEMA;
  query: string;
  suggestions: readonly ICommandSuggestion[];
} {
  const limit = options.limit ?? 10;
  const tokens = tokenize(partial);
  let entries = catalog;
  if (options.safeOnly) entries = entries.filter((c) => !c.writesSource);
  if (options.mcpSafeOnly) entries = entries.filter((c) => c.mcpAvailable);
  if (options.category) entries = entries.filter((c) => c.category === options.category);
  const scored: ICommandSuggestion[] = [];
  for (const e of entries) {
    const { score, reasons } = scoreCommandForQuery(e, tokens);
    if (score <= 0) continue;
    scored.push({
      command: e.command,
      category: e.category,
      description: e.description,
      safetyLevel: e.safetyLevel,
      score,
      reasons,
      writesSource: e.writesSource,
      mcpAvailable: e.mcpAvailable,
    });
  }
  scored.sort((a, b) => b.score - a.score || a.command.localeCompare(b.command));
  return {
    schema: COMMAND_SUGGESTIONS_SCHEMA,
    query: partial,
    suggestions: scored.slice(0, limit),
  };
}

/** Suggests at most `limit` did-you-mean candidates for an unknown command path. */
export function suggestDidYouMean(
  catalog: readonly ICommandEntryLike[],
  attempted: readonly string[],
  limit = 3,
): readonly ICommandSuggestion[] {
  const joined = attempted.join(' ').trim();
  if (!joined) return [];
  const { suggestions } = suggestCommands(catalog, joined, { limit });
  return suggestions;
}

export interface ICommandExplanation {
  schema: 'sharkcraft.command-explain/v1';
  query: string;
  exact?: ICommandEntryLike;
  candidates: readonly ICommandSuggestion[];
}

export function explainCommand(
  catalog: readonly ICommandEntryLike[],
  query: string,
): ICommandExplanation {
  const trimmed = query.trim();
  const exact = catalog.find((c) => c.command === trimmed);
  const { suggestions } = suggestCommands(catalog, trimmed, { limit: 5 });
  return {
    schema: 'sharkcraft.command-explain/v1',
    query: trimmed,
    ...(exact ? { exact } : {}),
    candidates: suggestions,
  };
}
