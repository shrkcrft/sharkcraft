import type { ISharkCraftConfig } from './sharkcraft-config.ts';
export interface ConfigValidationIssue {
    field: string;
    message: string;
    severity: 'error' | 'warning';
}
export interface ConfigValidationResult {
    valid: boolean;
    issues: ConfigValidationIssue[];
}
export declare function validateConfig(config: ISharkCraftConfig): ConfigValidationResult;
//# sourceMappingURL=config-validator.d.ts.map