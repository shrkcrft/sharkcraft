export interface IFolderInfo {
    path: string;
    exists: boolean;
    files: number;
    dirs: number;
}
export declare function shallowScanFolder(dir: string): IFolderInfo;
export declare function listTopLevelDirs(projectRoot: string, limit?: number): string[];
export declare function findFiles(startDir: string, pattern: RegExp, options?: {
    maxDepth?: number;
    ignore?: Set<string>;
}): string[];
//# sourceMappingURL=folder-scanner.d.ts.map