export declare function joinPath(...parts: string[]): string;
export declare function resolvePath(...parts: string[]): string;
export declare function normalizePath(p: string): string;
export declare function isAbsolutePath(p: string): boolean;
export declare function basename(p: string, ext?: string): string;
export declare function dirname(p: string): string;
export declare function extname(p: string): string;
export declare function relativePath(from: string, to: string): string;
export declare function isPathInside(child: string, parent: string): boolean;
export declare function ensureTrailingSlash(p: string): string;
export declare function stripTrailingSlash(p: string): string;
export declare function toPosix(p: string): string;
//# sourceMappingURL=path-utils.d.ts.map