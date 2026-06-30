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
  // Architecture Decisions rank just above the constraints they justify — a
  // Decision entry whose appliesWhen matches the task is high-signal context an
  // agent must not silently lose (previously these were dropped unless
  // --include-docs was set, then only in the lowest "Reference Docs" bucket).
  sectionPlans.push({ title: 'Architecture Decisions', priority: 82, entries: buckets.decisions });
  sectionPlans.push({ title: 'Architecture Constraints', priority: 80, entries: buckets.architecture });
  sectionPlans.push({ title: 'Conventions', priority: 75, entries: buckets.conventions });
  if (r.includePaths) {
    sectionPlans.push({ title: 'Relevant Path Conventions', priority: 70, entries: buckets.paths });
  }
  if (r.includeTemplates) {
    sectionPlans.push({ title: 'Relevant Templates', priority: 65, entries: buckets.templates });
  }
  sectionPlans.push({ title: 'Technical Stack', priority: 50, entries: buckets.technical });
  sectionPlans.push({ title: 'Testing Guidelines', priority: 45, entries: buckets.testing });
  sectionPlans.push({ title: 'Security Guidelines', priority: 44, entries: buckets.security });
  sectionPlans.push({ title: 'Workflows', priority: 42, entries: buckets.workflows });
  if (r.includeCommands) {
    sectionPlans.push({ title: 'Commands', priority: 40, entries: buckets.commands });
  }
  sectionPlans.push({ title: 'Current Tasks', priority: 30, entries: buckets.tasks });
  // Default "Project Knowledge" — the misc high-signal types. On by default;
  // suppress with includeKnowledge:false. Distinct from --include-docs, which
  // only ADDS the lowest-value overflow below.
  if (r.includeKnowledge !== false) {
    sectionPlans.push({ title: 'Project Knowledge', priority: 25, entries: buckets.knowledge });
  }
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

  // Sections at/above this priority degrade by TRUNCATION rather than vanishing
  // when they don't fit. Plans are processed in descending priority order, so
  // the current plan is always the highest-priority one still unplaced; a big
  // critical section (e.g. Agent Actions, 92) must not be dropped whole while a
  // small low-priority section is kept. Below the threshold, a non-fitting
  // section is omitted (and a later, smaller one may still fit).
  const PRUNE_PROTECT_PRIORITY = 80;

  function tryAddSection(
    title: string,
    body: string,
    entryIds: readonly string[],
    priority: number,
  ): void {
    const tokens = estimateTokens(body);
    if (used + tokens <= maxTokens) {
      sections.push({ title, body, entryIds, tokens });
      used += tokens;
      return;
    }
    const remaining = maxTokens - used;
    // Truncate-to-fit when this is the first section (nothing emitted yet) or a
    // protected high-priority one — provided there is any budget left.
    if (remaining > 0 && (sections.length === 0 || priority >= PRUNE_PROTECT_PRIORITY)) {
      const ratio = remaining / tokens;
      const truncatedBody = body.slice(0, Math.max(0, Math.floor(body.length * ratio))) + '\n…[truncated]';
      const truncTokens = estimateTokens(truncatedBody);
      sections.push({ title, body: truncatedBody, entryIds, tokens: truncTokens, truncated: true });
      used += truncTokens;
      return;
    }
    omitted.push(title);
  }

  for (const plan of sectionPlans) {
    if (plan.title === 'Project Overview' && r.projectOverview) {
      tryAddSection('Project Overview', r.projectOverview.trim(), [], plan.priority);
      continue;
    }
    // Composite section with a precomputed body (e.g. Agent Actions) — added in
    // priority order with its contributing-entry ids.
    if (plan.body !== undefined) {
      if (plan.body.length > 0) {
        tryAddSection(plan.title, plan.body, aggregated.contributingEntries, plan.priority);
      }
      continue;
    }
    if (plan.entries.length === 0) continue;
    const body = formatSectionBody(plan.entries, {
      includeExamples: r.includeExamples,
      maxContentChars: 1500,
    });
    const ids = plan.entries.map((e) => e.id);
    tryAddSection(plan.title, body, ids, plan.priority);
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
