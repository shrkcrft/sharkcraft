import type { IImportedEntry } from './imported-entry.ts';

export interface IImportWarning {
  origin: string;
  message: string;
}

export interface IImportResult {
  /** Source format that produced the entries. */
  format: string;
  /** Files that were read. */
  sourceFiles: string[];
  /** Parsed entries (deduped by id). */
  entries: IImportedEntry[];
  /** Non-fatal issues (missing headings, ambiguous priority, …). */
  warnings: IImportWarning[];
}
