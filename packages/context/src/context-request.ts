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
  includeOverview?: boolean;
  includeWarnings?: boolean;
  includeCommands?: boolean;
  projectOverview?: string;
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
  includeOverview: true,
  includeWarnings: true,
  includeCommands: false,
};
