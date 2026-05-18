import { type AppError, type Result } from '@shrkcrft/core';
export interface ITsConfig {
    target?: string;
    module?: string;
    strict?: boolean;
    paths?: Record<string, string[]>;
    baseUrl?: string;
    extends?: string;
    raw: Record<string, unknown>;
}
export declare function readTsConfig(projectRoot: string): Result<ITsConfig | null, AppError>;
//# sourceMappingURL=tsconfig-reader.d.ts.map