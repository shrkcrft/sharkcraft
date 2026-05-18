import { hasActionHints, type IKnowledgeEntry } from '@shrkcrft/knowledge';

export interface IActionHintQualityIssue {
  entryId: string;
  severity: 'warning';
  code:
    | 'missing-hints'
    | 'missing-commands-or-mcp'
    | 'missing-forbidden-actions'
    | 'missing-verification'
    | 'missing-write-policy'
    | 'missing-related-templates'
    | 'missing-related-path-conventions';
  message: string;
  /** Free-form suggestion the doctor can show next to the warning. */
  suggestion?: string;
}

export interface IActionHintQualityReport {
  /** Entries that were evaluated (matched the heuristics for "should have hints"). */
  evaluatedEntryCount: number;
  /** Subset that has at least one hint. */
  entriesWithHints: number;
  issues: IActionHintQualityIssue[];
  /** Top N entry ids by issue count for quick prioritization. */
  topMissing: Array<{ entryId: string; missingFields: string[] }>;
}

const GEN_KEYWORDS = ['generate', 'create', 'add', 'refactor', 'test', 'review'];

function appliesToGeneration(entry: IKnowledgeEntry): boolean {
  for (const a of entry.appliesWhen ?? []) {
    const lower = a.toLowerCase();
    if (GEN_KEYWORDS.some((k) => lower.includes(k))) return true;
  }
  return false;
}

function isCriticalOrHigh(entry: IKnowledgeEntry): boolean {
  const p = String(entry.priority);
  return p === 'critical' || p === 'high';
}

/**
 * Inspect knowledge entries for action-hint quality. Only critical / high
 * priority entries whose appliesWhen mentions generate/create/refactor/etc.
 * are evaluated — other entries (project overview, glossary, tech stack)
 * are not expected to carry hints.
 *
 * All issues are warnings (severity 'warning'). The doctor surfaces them as
 * "soft" findings.
 */
export function diagnoseActionHints(entries: readonly IKnowledgeEntry[]): IActionHintQualityReport {
  const issues: IActionHintQualityIssue[] = [];
  const missingByEntry = new Map<string, string[]>();
  let evaluated = 0;
  let withHints = 0;

  for (const entry of entries) {
    if (!isCriticalOrHigh(entry)) continue;
    if (!appliesToGeneration(entry)) continue;
    // Path / overview / technical entries describe location or facts — not actions.
    const type = String(entry.type);
    if (type === 'path' || type === 'overview' || type === 'technical') continue;
    evaluated += 1;
    const recordMissing = (field: string): void => {
      const list = missingByEntry.get(entry.id) ?? [];
      list.push(field);
      missingByEntry.set(entry.id, list);
    };
    if (!hasActionHints(entry)) {
      issues.push({
        entryId: entry.id,
        severity: 'warning',
        code: 'missing-hints',
        message: `Entry "${entry.id}" is high/critical and applies to generation but has no actionHints.`,
        suggestion: 'Add at least mcpTools/commands and forbiddenActions.',
      });
      recordMissing('all');
      continue;
    }
    withHints += 1;
    const h = entry.actionHints!;
    const hasCommandsOrTools = (h.commands?.length ?? 0) > 0 || (h.mcpTools?.length ?? 0) > 0;
    if (!hasCommandsOrTools) {
      issues.push({
        entryId: entry.id,
        severity: 'warning',
        code: 'missing-commands-or-mcp',
        message: `"${entry.id}" should list at least one CLI command or MCP tool.`,
      });
      recordMissing('commands/mcpTools');
    }
    // Generation-related entries should have forbiddenActions.
    if ((h.forbiddenActions?.length ?? 0) === 0) {
      issues.push({
        entryId: entry.id,
        severity: 'warning',
        code: 'missing-forbidden-actions',
        message: `"${entry.id}" should list at least one forbiddenActions item.`,
      });
      recordMissing('forbiddenActions');
    }
    // Verification commands matter for review/refactor/generate scopes.
    if ((h.verificationCommands?.length ?? 0) === 0) {
      issues.push({
        entryId: entry.id,
        severity: 'warning',
        code: 'missing-verification',
        message: `"${entry.id}" should list verificationCommands so the agent can validate the result.`,
      });
      recordMissing('verificationCommands');
    }
    // Write-related rules should declare writePolicy explicitly.
    const tagsLower = new Set(entry.tags.map((t) => t.toLowerCase()));
    const looksWriteRelated =
      tagsLower.has('safety') ||
      tagsLower.has('generator') ||
      (entry.appliesWhen ?? []).some((a) => /write|apply|generate/i.test(a));
    if (looksWriteRelated && !h.writePolicy) {
      issues.push({
        entryId: entry.id,
        severity: 'warning',
        code: 'missing-write-policy',
        message: `"${entry.id}" looks write-related but does not declare a writePolicy.`
      });
      recordMissing('writePolicy');
    }
    // Template rules should link relatedTemplates.
    if (
      tagsLower.has('template') &&
      (h.relatedTemplates?.length ?? 0) === 0
    ) {
      issues.push({
        entryId: entry.id,
        severity: 'warning',
        code: 'missing-related-templates',
        message: `"${entry.id}" is template-related but does not list relatedTemplates.`
      });
      recordMissing('relatedTemplates');
    }
    if (
      (tagsLower.has('path') || tagsLower.has('paths')) &&
      (h.relatedPathConventions?.length ?? 0) === 0
    ) {
      issues.push({
        entryId: entry.id,
        severity: 'warning',
        code: 'missing-related-path-conventions',
        message: `"${entry.id}" is path-related but does not list relatedPathConventions.`,
      });
      recordMissing('relatedPathConventions');
    }
  }

  const topMissing = [...missingByEntry.entries()]
    .map(([entryId, missingFields]) => ({ entryId, missingFields }))
    .sort((a, b) => b.missingFields.length - a.missingFields.length)
    .slice(0, 5);

  return {
    evaluatedEntryCount: evaluated,
    entriesWithHints: withHints,
    issues,
    topMissing,
  };
}
