export interface ProjectRootInfo {
    root: string;
    markers: string[];
}
export declare function detectProjectRoot(startDir: string): ProjectRootInfo;
export declare function findSharkcraftDir(projectRoot: string, configuredDir?: string): string | null;
//# sourceMappingURL=project-config-resolver.d.ts.map