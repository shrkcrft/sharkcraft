import type { IPackageJson } from './package-json-reader.ts';
export interface IFrameworkInfo {
    id: string;
    name: string;
    version?: string;
    evidence: string[];
}
export declare function detectFrameworks(projectRoot: string, pkg: IPackageJson | null): IFrameworkInfo[];
//# sourceMappingURL=framework-detector.d.ts.map