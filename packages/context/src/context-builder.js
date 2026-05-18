import { DEFAULT_CONTEXT_REQUEST } from "./context-request.js";
import { selectRelevantEntries } from "./relevance-selector.js";
import { formatEntryForContext, formatSectionBody } from "./ai-context-formatter.js";
import { estimateTokens } from "./token-estimator.js";
export function buildContext(allEntries, request) {
    const r = { ...DEFAULT_CONTEXT_REQUEST, ...request };
    const maxTokens = r.maxTokens ?? DEFAULT_CONTEXT_REQUEST.maxTokens;
    const buckets = selectRelevantEntries(allEntries, r);
    const sectionPlans = [];
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
    sectionPlans.sort((a, b) => b.priority - a.priority);
    const sections = [];
    const omitted = [];
    let used = 0;
    function tryAddSection(title, body, entryIds) {
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
        if (plan.entries.length === 0)
            continue;
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
    };
}
export { formatEntryForContext };
