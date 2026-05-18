import type { IKnowledgeEntry } from '@shrkcrft/knowledge';
import { type IContextRequest } from './context-request.ts';
import type { IContextResult } from './context-result.ts';
import { formatEntryForContext } from './ai-context-formatter.ts';
export declare function buildContext(allEntries: readonly IKnowledgeEntry[], request: IContextRequest): IContextResult;
export { formatEntryForContext };
//# sourceMappingURL=context-builder.d.ts.map