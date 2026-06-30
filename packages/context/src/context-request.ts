export interface IContextRequest {
  task: string;
  framework?: string;
  area?: string;
  tags?: readonly string[];
  scope?: readonly string[];
  appliesWhen?: readonly string[];
  maxTokens?: number;
  includeExamples?: boolean;
  includeTemplates?: boolean;
  includeRules?: boolean;
  includePaths?: boolean;
  includeDocs?: boolean;
  /**
   * Emit the default "Project Knowledge" section for genuinely-misc high-signal
   * types (feature / business / decision-adjacent / …). Defaults to `true`; set
   * `false` to suppress that section without losing the dedicated ones.
   */
  includeKnowledge?: boolean;
  includeOverview?: boolean;
  includeWarnings?: boolean;
  includeCommands?: boolean;
  projectOverview?: string;
  /**
   * Optional per-entry score boost (e.g. pack search-tuning). Applied as a
   * stable re-rank of the relevance results so a boosted entry can cross the
   * per-section cap. Returns a delta (0 = no boost). Kept as a plain structural
   * callback so the context layer needs no dependency on the inspector.
   */
  boostFor?: (entry: { readonly id: string; readonly type?: unknown; readonly tags?: readonly string[] }) => number;
}

export const DEFAULT_CONTEXT_REQUEST: Required<
  Pick<
    IContextRequest,
    | 'maxTokens'
    | 'includeExamples'
    | 'includeTemplates'
    | 'includeRules'
    | 'includePaths'
    | 'includeDocs'
    | 'includeKnowledge'
    | 'includeOverview'
    | 'includeWarnings'
    | 'includeCommands'
  >
> = {
  maxTokens: 4000,
  includeExamples: true,
  includeTemplates: true,
  includeRules: true,
  includePaths: true,
  includeDocs: false,
  includeKnowledge: true,
  includeOverview: true,
  includeWarnings: true,
  includeCommands: false,
};
