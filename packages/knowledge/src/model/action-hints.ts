/**
 * Action guidance attached to a knowledge entry.
 *
 * The model exists so structured knowledge can answer "what should the agent
 * do?" — not just "what is the rule?". Entries that are purely descriptive
 * (e.g. project-overview, glossary) leave actionHints undefined.
 */
export interface IActionHintCommand {
  /** A shell command. Placeholders like <task>, <repo>, <name> are conventional. */
  command: string;
  /** Why this command is run. */
  purpose?: string;
  /** Loose ordering hint: 'before' | 'during' | 'after' | free-form. */
  when?: string;
  /** True if the agent should treat this as mandatory for the flow. */
  required?: boolean;
}

export interface IActionHintMcpTool {
  /** MCP tool name (e.g. 'get_relevant_context'). */
  tool: string;
  purpose?: string;
  when?: string;
  required?: boolean;
}

export enum WritePolicy {
  CliOnly = 'cli-only',
  None = 'none',
  /** Reserved — currently no MCP tool writes; kept so packs can declare intent. */
  McpAllowed = 'mcp-allowed',
}

export interface IActionHints {
  /** CLI commands the agent should run. */
  commands?: readonly IActionHintCommand[];
  /** MCP tools the agent should call. */
  mcpTools?: readonly IActionHintMcpTool[];
  /**
   * Ordered list of step ids (MCP tool names, CLI command strings, or pipeline
   * step ids). Used by the context builder to render a "Preferred Flow"
   * section. The highest-priority entry that defines a preferredFlow wins
   * during aggregation.
   */
  preferredFlow?: readonly string[];
  /** Things the agent must NOT do. Free-text. */
  forbiddenActions?: readonly string[];
  /** Template ids likely needed. */
  relatedTemplates?: readonly string[];
  /** Path convention ids likely needed. */
  relatedPathConventions?: readonly string[];
  /** Other knowledge entry ids to cross-reference. */
  relatedKnowledge?: readonly string[];
  /** Commands to run after generation. */
  verificationCommands?: readonly string[];
  /** Reminders about safety, replay, idempotency etc. */
  safetyNotes?: readonly string[];
  /** True if a human must review before any write. */
  requiresHumanReview?: boolean;
  /** Who is allowed to actually write files. */
  writePolicy?: WritePolicy | 'cli-only' | 'mcp-allowed' | 'none';
}

export function hasActionHints(entry: { actionHints?: IActionHints }): boolean {
  const a = entry.actionHints;
  if (!a) return false;
  return Boolean(
    (a.commands && a.commands.length) ||
      (a.mcpTools && a.mcpTools.length) ||
      (a.preferredFlow && a.preferredFlow.length) ||
      (a.forbiddenActions && a.forbiddenActions.length) ||
      (a.relatedTemplates && a.relatedTemplates.length) ||
      (a.relatedPathConventions && a.relatedPathConventions.length) ||
      (a.relatedKnowledge && a.relatedKnowledge.length) ||
      (a.verificationCommands && a.verificationCommands.length) ||
      (a.safetyNotes && a.safetyNotes.length) ||
      a.requiresHumanReview !== undefined ||
      a.writePolicy !== undefined,
  );
}

/**
 * A command is a low-value placeholder when it has no concrete, runnable
 * content once conventional `<…>` placeholders and whitespace are stripped —
 * e.g. a bare `<command>` an agent dropped in to clear a presence gate. A
 * genuinely parameterized command (`shrk gen <template> <name>`) keeps concrete
 * tokens (`shrk gen`) and is NOT a placeholder.
 */
export function isPlaceholderCommand(command: string): boolean {
  return command.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().length === 0;
}

/**
 * Quality-aware successor to {@link hasActionHints}: true only when the entry
 * carries SUBSTANTIVE, actionable guidance — a concrete (non-placeholder)
 * command, an MCP tool, a verification command, a preferred flow, or a non-empty
 * forbidden-action / safety note. The presence-only signals an agent can bolt on
 * to game a coverage gate — an empty hints object, a lone `requiresHumanReview`,
 * a bare `writePolicy`, a `<command>` placeholder — do NOT count. Cross-
 * references (related*) are deliberately excluded here: their value depends on
 * RESOLUTION, so the corpus-level caller credits them only when they resolve.
 */
export function hasMeaningfulActionHints(entry: { actionHints?: IActionHints }): boolean {
  const a = entry.actionHints;
  if (!a) return false;
  if (a.commands?.some((c) => typeof c.command === 'string' && !isPlaceholderCommand(c.command))) {
    return true;
  }
  if (a.mcpTools && a.mcpTools.length > 0) return true;
  if (a.verificationCommands?.some((c) => c.trim().length > 0)) return true;
  if (a.preferredFlow?.some((s) => s.trim().length > 0)) return true;
  if (a.forbiddenActions?.some((s) => s.trim().length > 0)) return true;
  if (a.safetyNotes?.some((s) => s.trim().length > 0)) return true;
  return false;
}
