import type { IWorkspaceSummary } from '@shrkcrft/workspace';
export interface IProjectOverview {
    projectName: string;
    description?: string;
    packageManager: string;
    frameworks: string[];
    hasTypeScript: boolean;
    hasSharkcraftFolder: boolean;
    topLevelDirs: string[];
    knownScripts: string[];
}
export declare function buildProjectOverview(summary: IWorkspaceSummary, knowledgeProjectName?: string): IProjectOverview;
export declare function renderOverviewText(overview: IProjectOverview): string;
//# sourceMappingURL=project-overview.d.ts.map