import { type AppError, type Result } from '@shrkcrft/core';
export interface IPackageJson {
    name?: string;
    version?: string;
    description?: string;
    private?: boolean;
    type?: 'module' | 'commonjs';
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    workspaces?: string[] | {
        packages?: string[];
    };
    packageManager?: string;
    engines?: Record<string, string>;
    bin?: string | Record<string, string>;
    [key: string]: unknown;
}
export declare function readPackageJson(projectRoot: string): Result<IPackageJson | null, AppError>;
//# sourceMappingURL=package-json-reader.d.ts.map