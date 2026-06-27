import type { IKnowledgeEntry } from '@shrkcrft/knowledge';
import { aggregateActionHints, formatAggregatedHints } from '@shrkcrft/knowledge';
import { DEFAULT_CONTEXT_REQUEST, type IContextRequest } from './context-request.ts';
import type { IContextResult } from './context-result.ts';
import type { IContextSection } from './context-section.ts';
import { selectRelevantEntries } from './relevance-selector.ts';
import { formatEntryForContext, formatSectionBody } from './ai-context-formatter.ts';
import { estimateTokens } from './token-estimator.ts';

interface SectionPlan {
  title: string;
  priority: number;
  entries: IKnowledgeEntry[];
  /**
   * Precomputed body for COMPOSITE sections (e.g. "Agent Actions") that
   * aggregate across buckets rather than mapping a single bucket's entries.
   */
  body?: string;
}

export function buildContext(
  allEntries: readonly IKnowledgeEntry[],
  request: IContextRequest,
): IContextResult {
  const r: IContextRequest = { ...DEFAULT_CONTEXT_REQUEST, ...request };
  const maxTokens = r.maxTokens ?? DEFAULT_CONTEXT_REQUEST.maxTokens;
  const buckets = selectRelevantEntries(allEntries, r);

  const sectionPlans: SectionPlan[] = [];
  if (r.includeOverview && r.projectOverview) {
    sectionPlans.push({
      title: 'Project Overview',
      priority: 100,
      entries: [],
    });
  }
  if (r.includeWarnings && buckets.warnings.length) {
    sectionPlans.push({ title: 'Important Warnings', priority: 95, entries: buckets.warnings });
  }
  if (r.includeRules) {
    sectionPlans.push({ title: 'Relevant Rules', priority: 90, entries: buckets.rules });
  }
  sectionPlans.push({ title: 'Architecture Constraints', priority: 80, entries: buckets.architecture });
  if (r.includePaths) {
    sectionPlans.push({ title: 'Relevant Path Conventions', priority: 70, entries: buckets.paths });
  }
  if (r.includeTemplates) {
    sectionPlans.push({ title: 'Relevant Templates', priority: 65, entries: buckets.templates });
  }
  sectionPlans.push({ title: 'Technical Stack', priority: 50, entries: buckets.technical });
  sectionPlans.push({ title: 'Testing Guidelines', priority: 45, entries: buckets.testing });
  sectionPlans.push({ title: 'Security Guidelines', priority: 44, entries: buckets.security });
  if (r.includeCommands) {
    sectionPlans.push({ title: 'Commands', priority: 40, entries: buckets.commands });
  }
  sectionPlans.push({ title: 'Current Tasks', priority: 30, entries: buckets.tasks });
  if (r.includeDocs) {
    sectionPlans.push({ title: 'Reference Docs', priority: 10, entries: buckets.docs });
  }

  // Agent Actions: aggregate action hints (recommended MCP tools / CLI commands
  // / forbidden actions / verification commands / human-review points) from
  // every included entry into ONE composite section. Register it in the SAME
  // priority-sorted pipeline with a HIGH priority so it survives budget pruning
  // — it is the most agent-actionable section and was previously appended after
  // the loop with leftover budget, so it was the first thing dropped.
  const allIncludedEntries = sectionPlans.flatMap((p) => p.entries);
  const aggregated = aggregateActionHints(allIncludedEntries);
  const hintsBody = formatAggregatedHints(aggregated, { level: '###', compact: true });
  if (hintsBody && hintsBody.length > 0) {
    sectionPlans.push({ title: 'Agent Actions', priority: 92, entries: [], body: hintsBody });
  }

  sectionPlans.sort((a, b) => b.priority - a.priority);

  const sections: IContextSection[] = [];
  const omitted: string[] = [];
  let used = 0;

  function tryAddSection(title: string, body: string, entryIds: readonly string[]): void {
    const tokens = estimateTokens(body);
    if (used + tokens > maxTokens && sections.length > 0) {
      omitted.push(title);
      return;
    }
    if (used + tokens > maxTokens) {
      // Still emit, but mark truncated.
      const ratio = (maxTokens - used) / tokens;
      const truncatedBody = body.slice(0, Math.max(0, Math.floor(body.length * ratio))) + '\n…[truncated]';
      const truncTokens = estimateTokens(truncatedBody);
      sections.push({ title, body: truncatedBody, entryIds, tokens: truncTokens, truncated: true });
      used += truncTokens;
      return;
    }
    sections.push({ title, body, entryIds, tokens });
    used += tokens;
  }

  for (const plan of sectionPlans) {
    if (plan.title === 'Project Overview' && r.projectOverview) {
      tryAddSection('Project Overview', r.projectOverview.trim(), []);
      continue;
    }
    // Composite section with a precomputed body (e.g. Agent Actions) — added in
    // priority order with its contributing-entry ids.
    if (plan.body !== undefined) {
      if (plan.body.length > 0) tryAddSection(plan.title, plan.body, aggregated.contributingEntries);
      continue;
    }
    if (plan.entries.length === 0) continue;
    const body = formatSectionBody(plan.entries, {
      includeExamples: r.includeExamples,
      maxContentChars: 1500,
    });
    const ids = plan.entries.map((e) => e.id);
    tryAddSection(plan.title, body, ids);
  }

  const fullBody = sections
    .map((s) => `## ${s.title}${s.truncated ? ' (truncated)' : ''}\n\n${s.body}`)
    .join('\n\n');

  return {
    request: r,
    sections,
    totalTokens: used,
    maxTokens,
    omittedSections: omitted,
    body: fullBody,
    actionHints: aggregated,
  };
}

export { formatEntryForContext };
