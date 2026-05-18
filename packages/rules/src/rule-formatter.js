import { formatEntryCompact, formatEntryFull } from '@shrkcrft/knowledge';
export function formatRuleCompact(rule) {
    return formatEntryCompact(rule);
}
export function formatRuleFull(rule, options = {}) {
    return formatEntryFull(rule, { includeExamples: options.includeExamples ?? true });
}
export function formatRulesForAi(rules) {
    if (rules.length === 0)
        return 'No relevant rules found.';
    return rules
        .map((r, i) => `${i + 1}. [${r.id}] ${r.title}\n   ${r.content.trim()}`)
        .join('\n\n');
}
