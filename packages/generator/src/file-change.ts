import type { IPlannedOperation } from './operations.ts';

export enum FileChangeType {
  Create = 'create',
  /** Legacy v1 full-file overwrite when the same template is regenerated. */
  Update = 'update',
  /** v2: append snippet at the end of an existing file. */
  Append = 'append',
  /** v2: insert snippet immediately after an anchor in an existing file. */
  InsertAfter = 'insert-after',
  /** v2: insert snippet immediately before an anchor in an existing file. */
  InsertBefore = 'insert-before',
  /** v2: replace literal text in an existing file. */
  Replace = 'replace',
  /** v2: append a barrel re-export to an existing index file. */
  Export = 'export',
  /** Rename a folder. Apply-time only; preview-only by default. */
  RenameFolder = 'rename-folder',
  /** Delete a folder. Hard-gated; preview-only by default. */
  DeleteFolder = 'delete-folder',
  Skip = 'skip',
  Conflict = 'conflict',
}

export interface IFileChange {
  type: FileChangeType;
  absolutePath: string;
  relativePath: string;
  /** Final contents that would be written. For Skip the existing file is shown unchanged. */
  contents: string;
  /** Reason why this change has this type. */
  reason: string;
  /** Size of contents in bytes. */
  sizeBytes: number;
  /**
   * v2 only — the operation intent that produced this change. Absent on v1
   * CREATE entries that come from `files()` templates. Used by:
   *   - `saved-plan` to persist intent (so signature covers the operation)
   *   - dry-run rendering to show structural info (anchor / snippet preview)
   *   - apply-time divergence detection
   *
   * Type-only import of `IPlannedOperation` is safe: TS erases the import
   * at compile time, so there is no runtime cycle even though
   * `planned-change.ts` imports `FileChangeType` from this file.
   */
  operation?: IPlannedOperation;
}
