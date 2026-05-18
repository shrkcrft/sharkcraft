import {
  DEFAULT_DOC_FILES,
  DEFAULT_KNOWLEDGE_FILES,
  DEFAULT_PATH_FILES,
  DEFAULT_PIPELINE_FILES,
  DEFAULT_RULE_FILES,
  DEFAULT_SHARKCRAFT_DIR,
  DEFAULT_TEMPLATE_FILES,
  type ISharkCraftConfig,
} from './sharkcraft-config.ts';

export const DEFAULT_MAX_TOKENS = 4000;

export function getDefaultConfig(): Required<
  Pick<
    ISharkCraftConfig,
    | 'sharkcraftDir'
    | 'knowledgeFiles'
    | 'ruleFiles'
    | 'pathFiles'
    | 'templateFiles'
    | 'pipelineFiles'
    | 'docsFiles'
    | 'defaultMaxTokens'
    | 'defaultScope'
  >
> {
  return {
    sharkcraftDir: DEFAULT_SHARKCRAFT_DIR,
    knowledgeFiles: [...DEFAULT_KNOWLEDGE_FILES],
    ruleFiles: [...DEFAULT_RULE_FILES],
    pathFiles: [...DEFAULT_PATH_FILES],
    templateFiles: [...DEFAULT_TEMPLATE_FILES],
    pipelineFiles: [...DEFAULT_PIPELINE_FILES],
    docsFiles: [...DEFAULT_DOC_FILES],
    defaultMaxTokens: DEFAULT_MAX_TOKENS,
    defaultScope: [],
  };
}

export function withDefaults(config: ISharkCraftConfig | null | undefined): ISharkCraftConfig {
  const defaults = getDefaultConfig();
  if (!config) return defaults;
  return {
    ...defaults,
    ...config,
    knowledgeFiles: config.knowledgeFiles ?? defaults.knowledgeFiles,
    ruleFiles: config.ruleFiles ?? defaults.ruleFiles,
    pathFiles: config.pathFiles ?? defaults.pathFiles,
    templateFiles: config.templateFiles ?? defaults.templateFiles,
    pipelineFiles: config.pipelineFiles ?? defaults.pipelineFiles,
    docsFiles: config.docsFiles ?? defaults.docsFiles,
    defaultMaxTokens: config.defaultMaxTokens ?? defaults.defaultMaxTokens,
    defaultScope: config.defaultScope ?? defaults.defaultScope,
  };
}
