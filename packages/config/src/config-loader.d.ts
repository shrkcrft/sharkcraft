import { type AppError, type Result } from '@shrkcrft/core';
import type { ISharkCraftConfig } from './sharkcraft-config.ts';
export interface LoadedConfig {
    config: ISharkCraftConfig;
    projectRoot: string;
    sharkcraftDir: string;
    configFile: string | null;
}
export declare function loadProjectConfig(startDir: string): Promise<Result<LoadedConfig, AppError>>;
//# sourceMappingURL=config-loader.d.ts.map