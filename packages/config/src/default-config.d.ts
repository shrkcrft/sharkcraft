import { type ISharkCraftConfig } from './sharkcraft-config.ts';
export declare const DEFAULT_MAX_TOKENS = 4000;
export declare function getDefaultConfig(): Required<Pick<ISharkCraftConfig, 'sharkcraftDir' | 'knowledgeFiles' | 'ruleFiles' | 'pathFiles' | 'templateFiles' | 'docsFiles' | 'defaultMaxTokens' | 'defaultScope'>>;
export declare function withDefaults(config: ISharkCraftConfig | null | undefined): ISharkCraftConfig;
//# sourceMappingURL=default-config.d.ts.map