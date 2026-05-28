import type {
  IKnowledgeAuditEntry,
  IKnowledgeAuditFinding,
  IKnowledgeAuditReport,
  ILlmKnowledgeAuditFinding,
  KnowledgeAuditFindingSeverity,
} from './knowledge-audit.ts';

export type KnowledgeFixConfidence = 'high' | 'medium' | 'low';

export interface IKnowledgeFixInstruction {
  entryId: string;
  findingCategory: string;
  finding: string;
  severity: KnowledgeAuditFindingSeverity;
  intent: string;
  agentPrompt: string;
  confidence: KnowledgeFixConfidence;
  source: 'deterministic' | 'llm';
  llmSuggestion?: string;
}

export interface IKnowledgeSkippedFinding {
  entryId: string;
  findingCategory: string;
  finding: string;
  reason: string;
}

export interface IKnowledgeFixPlan {
  fixPlanId: string;
  generatedAt: string;
  auditId: string;
  /**
   * Knowledge entries are sourced from many files (config-driven). The plan
   * points the agent to the registered config so they can find each entry's
   * literal source by id.
   */
  sourceHint: string;
  fixes: readonly IKnowledgeFixInstruction[];
  skipped: readonly IKnowledgeSkippedFinding[];
  summary: {
    fixCount: number;
    highConfidence: number;
    mediumConfidence: number;
    lowConfidence: number;
    skipped: number;
  };
}

const SOURCE_HINT =
  'Edit knowledge entries via the files registered in `sharkcraft/sharkcraft.config.ts` (knowledgeFiles / ruleFiles / pathFiles). Locate the entry literal by its `id`.';

export function buildKnowledgeFixPlan(report: IKnowledgeAuditReport): IKnowledgeFixPlan {
  const fixes: IKnowledgeFixInstruction[] = [];
  const skipped: IKnowledgeSkippedFinding[] = [];

  for (const entry of report.entries) {
    for (const f of entry.deterministicFindings) {
      const out = dispatchDeterministic(entry, f);
      if (out.kind === 'fix') fixes.push(out.fix);
      else skipped.push(out.skip);
    }
    for (const f of entry.llmFindings) {
      fixes.push(makeLlmFix(entry, f));
    }
  }

  const summary = {
    fixCount: fixes.length,
    highConfidence: fixes.filter((f) => f.confidence === 'high').length,
    mediumConfidence: fixes.filter((f) => f.confidence === 'medium').length,
    lowConfidence: fixes.filter((f) => f.confidence === 'low').length,
    skipped: skipped.length,
  };

  const generatedAt = new Date().toISOString();
  return {
    fixPlanId: `fix-${generatedAt.replace(/[:.]/g, '-')}`,
    generatedAt,
    auditId: report.auditId,
    sourceHint: SOURCE_HINT,
    fixes,
    skipped,
    summary,
  };
}

type DispatchResult = { kind: 'fix'; fix: IKnowledgeFixInstruction } | { kind: 'skip'; skip: IKnowledgeSkippedFinding };

function dispatchDeterministic(
  entry: IKnowledgeAuditEntry,
  f: IKnowledgeAuditFinding,
): DispatchResult {
  // Stale-reference family: high-confidence fixes — the deterministic engine
  // already names the bad reference and (often) a replacement candidate.
  if (f.category.startsWith('knowledge-stale.')) {
    return makeFix(entry, f, f.severity === 'error' ? 'high' : 'medium',
      'Repair a stale or missing reference in this entry.',
      [
        `Locate knowledge entry "${entry.entryId}" (${SOURCE_HINT}).`,
        `Deterministic finding: ${f.message}`,
        f.fixSuggestion ? `Inspector-suggested fix: ${f.fixSuggestion}` : 'No automated fix candidate — verify the new symbol/file path manually.',
        `If a replacement exists, update the reference in place. Otherwise remove the stale reference. Verify the entry still parses.`,
      ].join('\n'),
    );
  }
  switch (f.category) {
    case 'knowledge.summary-missing':
      return makeFix(entry, f, 'high',
        'Add a one-sentence summary.',
        [
          `Locate knowledge entry "${entry.entryId}" (${SOURCE_HINT}).`,
          f.stubSuggestion
            ? `Inspector-suggested stub: ${f.stubSuggestion}`
            : `Add a \`summary\` field — one sentence that lets a reader grok the entry without opening it.`,
          'Verify the entry still parses.',
        ].join('\n'),
      );
    case 'knowledge.tags-missing':
      return makeFix(entry, f, 'high',
        'Add tags so the entry surfaces in tag-based searches.',
        [
          `Locate knowledge entry "${entry.entryId}" (${SOURCE_HINT}).`,
          'Add a `tags` array with 1–3 short kebab-case tags reflecting topic + scope.',
          'Verify the entry still parses.',
        ].join('\n'),
      );
    case 'knowledge.title-missing':
      return makeFix(entry, f, 'high',
        'Add a `title` field.',
        [
          `Locate knowledge entry "${entry.entryId}" (${SOURCE_HINT}).`,
          'Add a `title: "<short human-readable name>"` field — used in lists and reports.',
          'Verify the entry still parses.',
        ].join('\n'),
      );
    case 'knowledge.summary-too-long':
      return makeFix(entry, f, 'medium',
        'Tighten the summary.',
        [
          `Locate knowledge entry "${entry.entryId}" (${SOURCE_HINT}).`,
          `Trim the \`summary\` to ≤ 320 chars. If you can't, move detail into \`body\` instead.`,
        ].join('\n'),
      );
    default:
      if (f.category.includes('obsolete-entry')) {
        return {
          kind: 'skip',
          skip: {
            entryId: entry.entryId,
            findingCategory: f.category,
            finding: f.message,
            reason: 'obsolete-entry — human/agent must decide to retire or refresh; do not auto-remove.',
          },
        };
      }
      return makeFix(entry, f, 'low',
        `Address finding "${f.category}".`,
        [
          `Locate knowledge entry "${entry.entryId}" (${SOURCE_HINT}).`,
          `The audit reported: ${f.message}`,
          f.fixSuggestion ?? f.stubSuggestion
            ? `Inspector-suggested fix: ${f.fixSuggestion ?? f.stubSuggestion}`
            : 'No specific suggestion was supplied — use judgment.',
          `Apply a minimal change that resolves the finding without touching unrelated fields. Verify the entry still parses.`,
        ].filter(Boolean).join('\n'),
      );
  }
}

function makeFix(
  entry: IKnowledgeAuditEntry,
  f: IKnowledgeAuditFinding,
  confidence: KnowledgeFixConfidence,
  intent: string,
  agentPrompt: string,
): DispatchResult {
  return {
    kind: 'fix',
    fix: {
      entryId: entry.entryId,
      findingCategory: f.category,
      finding: f.message,
      severity: f.severity,
      intent,
      agentPrompt,
      confidence,
      source: 'deterministic',
    },
  };
}

function makeLlmFix(
  entry: IKnowledgeAuditEntry,
  f: ILlmKnowledgeAuditFinding,
): IKnowledgeFixInstruction {
  return {
    entryId: entry.entryId,
    findingCategory: f.category,
    finding: f.message,
    severity: f.severity,
    intent: `Review the LLM-flagged "${f.category}" finding and decide whether to act.`,
    agentPrompt: [
      `Locate knowledge entry "${entry.entryId}" (${SOURCE_HINT}).`,
      `An LLM critique flagged (confidence ${f.confidence.toFixed(2)}): ${f.message}`,
      `LLM findings are advisory — verify against the entry body and sibling entries before acting.`,
      `If you choose to act, keep the change minimal. If you don't, record the decision in your response.`,
    ].join('\n'),
    confidence: 'low',
    source: 'llm',
  };
}
