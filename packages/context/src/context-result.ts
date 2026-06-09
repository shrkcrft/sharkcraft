import type { IAggregatedActionHints } from '@shrkcrft/knowledge';
import type { IContextSection } from './context-section.ts';
import type { IContextRequest } from './context-request.ts';

export interface IContextResult {
  request: IContextRequest;
  sections: readonly IContextSection[];
  totalTokens: number;
  maxTokens: number;
  omittedSections: readonly string[];
  /** Combined render of all sections (in order). */
  body: string;
  /**
   * Aggregated action hints from every included entry — the same structured
   * bundle `shrk task` exposes (preferredFlow / forbiddenActions /
   * verificationCommands / writePolicy / …). Also rendered into `body` as the
   * "Agent Actions" section, but exposed here so JSON consumers don't have to
   * parse markdown to recover it.
   */
  actionHints: IAggregatedActionHints;
}
