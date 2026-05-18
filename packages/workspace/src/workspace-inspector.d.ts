import type { IWorkspaceSummary } from './workspace-summary.ts';
export interface InspectWorkspaceOptions {
    startDir?: string;
    sharkcraftDirName?: string;
}
export declare function inspectWorkspace(options?: InspectWorkspaceOptions): Promise<IWorkspaceSummary>;
//# sourceMappingURL=workspace-inspector.d.ts.map