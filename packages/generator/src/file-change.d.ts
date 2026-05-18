export declare enum FileChangeType {
    Create = "create",
    Update = "update",
    Skip = "skip",
    Conflict = "conflict"
}
export interface IFileChange {
    type: FileChangeType;
    absolutePath: string;
    relativePath: string;
    /** Final contents that would be written for create/update. */
    contents: string;
    /** Reason why this change has this type. */
    reason: string;
    /** Size of contents in bytes. */
    sizeBytes: number;
}
//# sourceMappingURL=file-change.d.ts.map