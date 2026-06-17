/**
 * Operation union — declared by templates, persisted in saved plans.
 * Part of the v2 generation model.
 */

export type PlannedOperationKind =
  | 'create'
  | 'append'
  | 'insert-after'
  | 'insert-before'
  | 'replace'
  | 'export'
  | 'ensure-import'
  | 'insert-enum-entry'
  | 'insert-object-entry'
  | 'insert-array-entry'
  | 'insert-before-closing-brace'
  | 'insert-between-anchors';

export interface ICreateOperation {
  kind: 'create';
  content: string;
  description?: string;
}

export interface IAppendOperation {
  kind: 'append';
  /**
   * The snippet to append at the end of the file. The engine adds a single
   * `\n` separator between the existing trailing content and the snippet if
   * the existing file does not already end with a newline.
   */
  snippet: string;
  /**
   * Optional idempotency marker. If the existing file already contains this
   * string anywhere, the operation is skipped (already applied).
   */
  ifMissing?: string;
  description?: string;
}

export interface IInsertAfterOperation {
  kind: 'insert-after';
  /** Literal substring that must appear exactly once in the file. */
  anchor: string;
  /** The snippet to insert immediately after `anchor`. */
  snippet: string;
  /** Idempotency check; default = `snippet`. */
  ifMissing?: string;
  description?: string;
}

export interface IInsertBeforeOperation {
  kind: 'insert-before';
  anchor: string;
  snippet: string;
  ifMissing?: string;
  description?: string;
}

export interface IReplaceOperation {
  kind: 'replace';
  /** Literal substring to find. */
  find: string;
  /** Replacement text. */
  replaceWith: string;
  /**
   * If provided, the engine requires exactly this many matches; otherwise the
   * default is exactly 1. Multiple matches without an explicit `expectMatches`
   * is a conflict (ambiguous replace).
   */
  expectMatches?: number;
  description?: string;
}

export interface IExportOperation {
  kind: 'export';
  /** The symbol/path to re-export. */
  from: string;
  /** Optional named symbols. When omitted, emits `export * from`. */
  symbols?: readonly string[];
  /** Idempotency check; default = computed export line. */
  ifMissing?: string;
  description?: string;
}

export interface IEnsureImportOperation {
  kind: 'ensure-import';
  /** Module specifier, e.g. `'./events'` or `'@app/plugin-core'`. */
  from: string;
  /**
   * Named symbols to ensure. The op is a NO-OP for symbols already imported
   * from `from`. Default import (`type: 'default'`) and namespace import
   * (`type: 'namespace'`) are also supported via dedicated fields below.
   */
  symbols?: readonly string[];
  /** Treat the import as `import type { ... }` instead of value import. */
  typeOnly?: boolean;
  /** Default import binding (e.g. `import Foo from 'foo'`). */
  defaultBinding?: string;
  /** Namespace import binding (e.g. `import * as foo from 'foo'`). */
  namespaceBinding?: string;
  description?: string;
}

export interface IInsertEnumEntryOperation {
  kind: 'insert-enum-entry';
  /** Enum identifier, e.g. `PaginationEventType`. */
  enumName: string;
  /** Identifier of the new enum member, e.g. `ITEM_SELECTED`. */
  entryName: string;
  /** Literal string value to assign, e.g. `'pagination.itemSelected'`. */
  entryValue: string;
  description?: string;
}

export interface IInsertObjectEntryOperation {
  kind: 'insert-object-entry';
  /** Object identifier, e.g. `ROUTE_KEYS`. */
  objectName: string;
  /** Key to add. */
  entryKey: string;
  /** Value literal (already source-formatted). */
  entryValue: string;
  /** When `true`, allow shorthand entries; default `false`. */
  shorthand?: boolean;
  description?: string;
}

export interface IInsertArrayEntryOperation {
  kind: 'insert-array-entry';
  /**
   * Array identifier — a `const`/`let`/`var` bound to an array literal,
   * e.g. `editorScopeEntries` or `DEFAULT_PANELS`. The element is inserted
   * before the array's matching closing bracket.
   */
  arrayName: string;
  /** Element source text to add (already source-formatted, no trailing comma). */
  entryValue: string;
  /** Optional idempotency marker (default = `entryValue`). */
  ifMissing?: string;
  description?: string;
}

export interface IInsertBeforeClosingBraceOperation {
  kind: 'insert-before-closing-brace';
  /** Container identifier, e.g. an interface/class/enum name. */
  containerName: string;
  /** Snippet inserted immediately before the matching closing brace. */
  snippet: string;
  /** Optional idempotency marker (default = `snippet`). */
  ifMissing?: string;
  description?: string;
}

export interface IInsertBetweenAnchorsOperation {
  kind: 'insert-between-anchors';
  beginAnchor: string;
  endAnchor: string;
  snippet: string;
  /** Optional idempotency marker (default = `snippet`). */
  ifMissing?: string;
  description?: string;
}

export type IPlannedOperation =
  | ICreateOperation
  | IAppendOperation
  | IInsertAfterOperation
  | IInsertBeforeOperation
  | IReplaceOperation
  | IExportOperation
  | IEnsureImportOperation
  | IInsertEnumEntryOperation
  | IInsertObjectEntryOperation
  | IInsertArrayEntryOperation
  | IInsertBeforeClosingBraceOperation
  | IInsertBetweenAnchorsOperation;
