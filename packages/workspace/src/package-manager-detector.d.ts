import type { IPackageJson } from './package-json-reader.ts';
export declare enum PackageManager {
    Bun = "bun",
    Pnpm = "pnpm",
    Yarn = "yarn",
    Npm = "npm",
    Unknown = "unknown"
}
export interface IPackageManagerInfo {
    manager: PackageManager;
    version?: string;
    evidence: string[];
}
export declare function detectPackageManager(projectRoot: string, pkg: IPackageJson | null): IPackageManagerInfo;
//# sourceMappingURL=package-manager-detector.d.ts.map