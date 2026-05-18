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
}
