import { type IKnowledgeEntry } from '@shrkcrft/knowledge';
import type { IRule } from './rule.ts';
export declare function formatRuleCompact(rule: IRule): string;
export declare function formatRuleFull(rule: IRule, options?: {
    includeExamples?: boolean;
}): string;
export declare function formatRulesForAi(rules: readonly IKnowledgeEntry[]): string;
//# sourceMappingURL=rule-formatter.d.ts.map