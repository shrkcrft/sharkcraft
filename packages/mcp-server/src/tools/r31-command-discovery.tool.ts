/**
 * Read-only MCP tools for command discovery.
 *
 * `suggest_commands` — fuzzy-tolerant suggestions for a partial command.
 * `search_commands` — substring + keyword search across the catalog.
 *
 * Both are read-only. MCP does not execute the suggested commands.
 */
import {
  explainCommand,
  suggestCommands,
  type ICommandEntryLike,
} from '@shrkcrft/inspector';
import { COMMAND_CATALOG_EXPORT } from './command-catalog.tool.ts';
import type { IToolDefinition } from '../server/tool-definition.ts';

const COMMAND_CATALOG: readonly ICommandEntryLike[] = COMMAND_CATALOG_EXPORT.map((e) => ({
  command: e.command,
  description: e.description,
  category: e.category,
  safetyLevel: e.safetyLevel,
  writesFiles: e.writesFiles,
  writesSource: e.writesSource,
  runsShell: e.runsShell,
  requiresReview: e.requiresReview,
  mcpAvailable: e.mcpAvailable,
  aliases: e.aliases,
}));

const INPUT_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  required: ['query'],
  properties: {
    query: { type: 'string' as const, description: 'Partial command, typo, or keyword.' },
    limit: { type: 'number' as const, description: 'Cap results. Default 10.' },
    safeOnly: { type: 'boolean' as const, description: 'Exclude commands that write source.' },
    mcpSafeOnly: { type: 'boolean' as const, description: 'Only include commands callable via MCP.' },
    category: { type: 'string' as const, description: 'Filter to a single category.' },
  },
};

function next(hint: string): string {
  return `Next: \`${hint}\` (CLI is the only write path).`;
}

export const suggestCommandsTool: IToolDefinition = {
  name: 'suggest_commands',
  description:
    'Typo-tolerant suggestions for a partial command (e.g. "knowlege" → "knowledge"). Read-only. Results are annotated with `tier` and `gatedDefault`; experimental commands need `shrk surface enable <cmd>` before they can be called.',
  inputSchema: INPUT_SCHEMA,
  async handler(input) {
    const query = String(input.query ?? '');
    const limit = typeof input.limit === 'number' ? input.limit : 10;
    const safeOnly = !!input.safeOnly;
    const mcpSafeOnly = !!input.mcpSafeOnly;
    const category = typeof input.category === 'string' ? input.category : undefined;
    const result = suggestCommands(COMMAND_CATALOG, query, {
      limit,
      safeOnly,
      mcpSafeOnly,
      ...(category ? { category } : {}),
    });
    return {
      text: next(`shrk commands suggest "${query}"`),
      data: annotateSuggestResult(result),
    };
  },
};

/**
 * Annotate suggestCommands output with tier info from
 * the catalog snapshot. The snapshot doesn't know the project's
 * surface config, so `gatedDefault: true` means "tier=experimental
 * in the static catalog; the host CLI may have enabled it via
 * surface.enabled[]." Agents should check `get_command_catalog` (or
 * the host's `shrk surface list`) to confirm before invocation.
 */
function annotateSuggestResult(result: ReturnType<typeof suggestCommands>): unknown {
  const r = result as unknown as { suggestions?: ReadonlyArray<{ command?: string; [k: string]: unknown }> };
  const suggestions = (r.suggestions ?? []).map((s) => {
    const entry = COMMAND_CATALOG.find((c) => c.command === s.command);
    const tier = (entry as { tier?: string } | undefined)?.tier ?? 'extended';
    return {
      ...s,
      tier,
      gatedDefault: tier === 'experimental',
      ...(tier === 'experimental' ? { enableHint: `shrk surface enable ${s.command} --write` } : {}),
    };
  });
  return {
    ...result,
    suggestions,
    gatingHint:
      'Tier values are best-effort from the static catalog. Confirm with `get_command_catalog` or `shrk surface list` in the host project before invoking experimental commands.',
  };
}

export const searchCommandsTool: IToolDefinition = {
  name: 'search_commands',
  description:
    'Search the command catalog by substring or keyword. Returns matching commands with safety + MCP availability metadata. Read-only.',
  inputSchema: INPUT_SCHEMA,
  async handler(input) {
    const query = String(input.query ?? '').toLowerCase();
    const limit = typeof input.limit === 'number' ? input.limit : 25;
    const safeOnly = !!input.safeOnly;
    const mcpSafeOnly = !!input.mcpSafeOnly;
    const category = typeof input.category === 'string' ? input.category : undefined;
    let filtered = COMMAND_CATALOG.filter(
      (c) =>
        !query ||
        c.command.toLowerCase().includes(query) ||
        c.description.toLowerCase().includes(query) ||
        c.aliases.some((a) => a.toLowerCase().includes(query)),
    );
    if (safeOnly) filtered = filtered.filter((c) => !c.writesSource);
    if (mcpSafeOnly) filtered = filtered.filter((c) => c.mcpAvailable);
    if (category) filtered = filtered.filter((c) => c.category === category);
    return {
      text: next(`shrk commands search "${query}"`),
      data: {
        schema: 'sharkcraft.command-search/v1',
        query,
        count: filtered.length,
        results: filtered.slice(0, limit),
      },
    };
  },
};

export const explainCommandTool: IToolDefinition = {
  name: 'explain_command',
  description: 'Explain a command — exact catalog entry + near matches. Read-only.',
  inputSchema: INPUT_SCHEMA,
  async handler(input) {
    const query = String(input.query ?? '');
    const report = explainCommand(COMMAND_CATALOG, query);
    return { text: next(`shrk commands explain "${query}"`), data: report };
  },
};
