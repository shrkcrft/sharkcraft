import { type IKnowledgeEntry } from '@shrkcrft/knowledge';
import type { IRule } from './rule.ts';
import type { IRuleQuery } from './rule-query.ts';
export declare class RuleService {
    private readonly index;
    constructor(entries: readonly IKnowledgeEntry[]);
    list(): IRule[];
    get(id: string): IRule | null;
    search(query: IRuleQuery): IRule[];
    getRelevant(task: string, options?: Partial<IRuleQuery>): IRule[];
}
//# sourceMappingURL=rule-service.d.ts.map