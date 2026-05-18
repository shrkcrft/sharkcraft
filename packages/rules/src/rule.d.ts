import type { IKnowledgeEntry } from '@shrkcrft/knowledge';
import { type DefineKnowledgeInput } from '@shrkcrft/knowledge';
export type IRule = IKnowledgeEntry;
export type DefineRuleInput = Omit<DefineKnowledgeInput, 'type'> & {
    type?: string;
};
export declare function defineRule(input: DefineRuleInput): IRule;
//# sourceMappingURL=rule.d.ts.map