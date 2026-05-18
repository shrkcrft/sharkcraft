export interface ISharkCraftConfig {
    /** Optional project identifier used in outputs / context. */
    projectName?: string;
    /** Human-readable one-line project description. */
    description?: string;
    /** Folder (relative to project root) containing SharkCraft project data. */
    sharkcraftDir?: string;
    /** Knowledge entry files (TS or markdown). Relative to sharkcraftDir. */
    knowledgeFiles?: string[];
    /** Markdown doc files (optional human depth). Relative to sharkcraftDir. */
    docsFiles?: string[];
    /** Rule registry files. */
    ruleFiles?: string[];
    /** Path-convention registry files. */
    pathFiles?: string[];
    /** Template registry files. */
    templateFiles?: string[];
    /** Default token budget for context retrieval. */
    defaultMaxTokens?: number;
    /** Default frameworks/scopes this project belongs to. */
    defaultScope?: string[];
    /** Free-form metadata. */
    metadata?: Record<string, unknown>;
}
export declare const DEFAULT_SHARKCRAFT_DIR = "sharkcraft";
export declare const DEFAULT_KNOWLEDGE_FILES: string[];
export declare const DEFAULT_RULE_FILES: string[];
export declare const DEFAULT_PATH_FILES: string[];
export declare const DEFAULT_TEMPLATE_FILES: string[];
export declare const DEFAULT_DOC_FILES: string[];
export declare function defineSharkCraftConfig(config: ISharkCraftConfig): ISharkCraftConfig;
//# sourceMappingURL=sharkcraft-config.d.ts.map