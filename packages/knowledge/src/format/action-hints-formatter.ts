import type { IKnowledgeEntry } from '../model/knowledge-entry.ts';
import type {
  IActionHintCommand,
  IActionHintMcpTool,
  IActionHints,
} from '../model/action-hints.ts';
import { priorityWeight } from '../model/knowledge-priority.ts';

export interface IAggregatedActionHints {
  commands: IActionHintCommand[];
  mcpTools: IActionHintMcpTool[];
  preferredFlow: readonly string[];
  preferredFlowSourceId?: string;
  forbiddenActions: string[];
  relatedTemplates: string[];
  relatedPathConventions: string[];
  relatedKnowledge: string[];
  verificationCommands: string[];
  safetyNotes: string[];
  requiresHumanReview: boolean;
  writePolicy?: string;
  /** Entry ids that contributed at least one hint. */
  contributingEntries: string[];
}

function dedupePush<T>(out: T[], items: readonly T[] | undefined, key: (item: T) => string): void {
  if (!items) return;
  const seen = new Set(out.map(key));
  for (const item of items) {
    const k = key(item);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(item);
    }
  }
}

function dedupeStrings(out: string[], items: readonly string[] | undefined): void {
  dedupePush(out, items, (s) => s);
}

/**
 * Combine actionHints from a list of relevant entries into a single bundle.
 * Order of entries determines tie-breaking: the highest-priority entry wins
 * for `preferredFlow` and `writePolicy`. Other fields are deduped union.
 */
export function aggregateActionHints(
  entries: readonly IKnowledgeEntry[],
): IAggregatedActionHints {
  const out: IAggregatedActionHints = {
    commands: [],
    mcpTools: [],
    preferredFlow: [],
    forbiddenActions: [],
    relatedTemplates: [],
    relatedPathConventions: [],
    relatedKnowledge: [],
    verificationCommands: [],
    safetyNotes: [],
    requiresHumanReview: false,
    contributingEntries: [],
  };

  // Sort by priority desc so highest-priority entries win for "preferredFlow".
  const sorted = [...entries].sort(
    (a, b) =>
      priorityWeight(b.priority as never) - priorityWeight(a.priority as never),
  );

  for (const entry of sorted) {
    const h = entry.actionHints;
    if (!h) continue;
    dedupePush(out.commands, h.commands, (c) => c.command);
    dedupePush(out.mcpTools, h.mcpTools, (m) => m.tool);
    if (!out.preferredFlow.length && h.preferredFlow?.length) {
      out.preferredFlow = h.preferredFlow;
      out.preferredFlowSourceId = entry.id;
    }
    dedupeStrings(out.forbiddenActions, h.forbiddenActions);
    dedupeStrings(out.relatedTemplates, h.relatedTemplates);
    dedupeStrings(out.relatedPathConventions, h.relatedPathConventions);
    dedupeStrings(out.relatedKnowledge, h.relatedKnowledge);
    dedupeStrings(out.verificationCommands, h.verificationCommands);
    dedupeStrings(out.safetyNotes, h.safetyNotes);
    if (h.requiresHumanReview) out.requiresHumanReview = true;
    if (h.writePolicy && !out.writePolicy) out.writePolicy = String(h.writePolicy);
    out.contributingEntries.push(entry.id);
  }
  return out;
}

export interface FormatActionHintsOptions {
  /** Title prefix (used by the context builder as section headings). */
  level?: '##' | '###';
  /** When true, omit empty subsections instead of rendering a heading. */
  compact?: boolean;
}

function formatCmd(c: IActionHintCommand): string {
  const req = c.required ? ' (required)' : '';
  const when = c.when ? ` — when: ${c.when}` : '';
  const purpose = c.purpose ? ` — ${c.purpose}` : '';
  return `\`${c.command}\`${req}${purpose}${when}`;
}

function formatTool(t: IActionHintMcpTool): string {
  const req = t.required ? ' (required)' : '';
  const when = t.when ? ` — when: ${t.when}` : '';
  const purpose = t.purpose ? ` — ${t.purpose}` : '';
  return `\`${t.tool}\`${req}${purpose}${when}`;
}

export function formatAggregatedHints(
  hints: IAggregatedActionHints,
  options: FormatActionHintsOptions = {},
): string {
  const level = options.level ?? '##';
  const lines: string[] = [];
  function section(name: string, body: string): void {
    if (!body) return;
    lines.push(`${level} ${name}`);
    lines.push('');
    lines.push(body);
    lines.push('');
  }

  section(
    'Recommended MCP Tools',
    hints.mcpTools.map((t) => `- ${formatTool(t)}`).join('\n'),
  );
  section(
    'Recommended CLI Commands',
    hints.commands.map((c) => `- ${formatCmd(c)}`).join('\n'),
  );
  if (hints.preferredFlow.length) {
    const src = hints.preferredFlowSourceId ? ` _(from ${hints.preferredFlowSourceId})_` : '';
    section(
      `Preferred Flow${src}`,
      hints.preferredFlow.map((s, i) => `${i + 1}. ${s}`).join('\n'),
    );
  }
  section(
    'Forbidden Actions',
    hints.forbiddenActions.map((a) => `- ${a}`).join('\n'),
  );
  section(
    'Verification Commands',
    hints.verificationCommands.map((c) => `- \`${c}\``).join('\n'),
  );
  section(
    'Safety Notes',
    hints.safetyNotes.map((n) => `- ${n}`).join('\n'),
  );
  if (hints.relatedTemplates.length) {
    section(
      'Related Templates',
      hints.relatedTemplates.map((t) => `- \`${t}\``).join('\n'),
    );
  }
  if (hints.relatedPathConventions.length) {
    section(
      'Related Path Conventions',
      hints.relatedPathConventions.map((p) => `- \`${p}\``).join('\n'),
    );
  }
  if (hints.requiresHumanReview || hints.writePolicy) {
    const parts: string[] = [];
    if (hints.requiresHumanReview) parts.push('Requires human review.');
    if (hints.writePolicy) parts.push(`Write policy: \`${hints.writePolicy}\`.`);
    section('Human Review Points', parts.map((p) => `- ${p}`).join('\n'));
  }

  if (options.compact && lines.length === 0) return '';
  return lines.join('\n').trim();
}

export function formatEntryActionHints(
  entry: IKnowledgeEntry,
  options: FormatActionHintsOptions = {},
): string {
  if (!entry.actionHints) return '';
  return formatAggregatedHints(aggregateActionHints([entry]), options);
}

/** Returns a single text block for an aggregated bundle. Useful for CLI output. */
export function aggregatedHintsToText(hints: IAggregatedActionHints): string {
  return formatAggregatedHints(hints, { compact: true });
}
