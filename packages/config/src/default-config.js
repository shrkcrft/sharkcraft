import { DEFAULT_DOC_FILES, DEFAULT_KNOWLEDGE_FILES, DEFAULT_PATH_FILES, DEFAULT_RULE_FILES, DEFAULT_SHARKCRAFT_DIR, DEFAULT_TEMPLATE_FILES, } from "./sharkcraft-config.js";
export const DEFAULT_MAX_TOKENS = 4000;
export function getDefaultConfig() {
    return {
        sharkcraftDir: DEFAULT_SHARKCRAFT_DIR,
        knowledgeFiles: [...DEFAULT_KNOWLEDGE_FILES],
        ruleFiles: [...DEFAULT_RULE_FILES],
        pathFiles: [...DEFAULT_PATH_FILES],
        templateFiles: [...DEFAULT_TEMPLATE_FILES],
        docsFiles: [...DEFAULT_DOC_FILES],
        defaultMaxTokens: DEFAULT_MAX_TOKENS,
        defaultScope: [],
    };
}
export function withDefaults(config) {
    const defaults = getDefaultConfig();
    if (!config)
        return defaults;
    return {
        ...defaults,
        ...config,
        knowledgeFiles: config.knowledgeFiles ?? defaults.knowledgeFiles,
        ruleFiles: config.ruleFiles ?? defaults.ruleFiles,
        pathFiles: config.pathFiles ?? defaults.pathFiles,
        templateFiles: config.templateFiles ?? defaults.templateFiles,
        docsFiles: config.docsFiles ?? defaults.docsFiles,
        defaultMaxTokens: config.defaultMaxTokens ?? defaults.defaultMaxTokens,
        defaultScope: config.defaultScope ?? defaults.defaultScope,
    };
}
