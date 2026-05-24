/**
 * Public-API surface snapshot for a workspace package or the whole
 * repo. Produced from a `@shrkcrft/graph` snapshot; consumed by the
 * diff engine to detect breaking changes.
 */
export const API_SURFACE_SCHEMA = 'sharkcraft.api-surface/v1' as const;
export const API_SURFACE_DIFF_SCHEMA = 'sharkcraft.api-surface-diff/v1' as const;

export type ApiSymbolKind =
  | 'class'
  | 'function'
  | 'interface'
  | 'type-alias'
  | 'enum'
  | 'const'
  | 'let'
  | 'var'
  | 'module'
  | 'namespace'
  | 'unknown';

export interface IPublicSymbol {
  /** Symbol node id (e.g. `symbol:packages/foo/src/index.ts#myFn`). */
  id: string;
  /** Symbol name as exposed by the file. */
  name: string;
  /** Declaration kind. */
  kind: ApiSymbolKind;
  /** File where the symbol is declared. */
  file: string;
  /** Workspace package name (if known). */
  package?: string;
  /** True for default exports. */
  isDefault: boolean;
  /**
   * Canonical signature string from the TS type checker, when
   * extracted via `extractApiSurfaceWithProgram`. Absent for surfaces
   * captured from the AST-only graph snapshot.
   */
  signature?: string;
}

export interface IApiSurface {
  schema: typeof API_SURFACE_SCHEMA;
  /** Top-level project root (POSIX-normalised) when known. */
  projectRoot?: string;
  /** When set, only entries under one of these packages are included. */
  packageFilter?: readonly string[];
  /** Symbols sorted by id ascending. */
  symbols: readonly IPublicSymbol[];
  /** Per-package summary counts. */
  countsByPackage: Readonly<Record<string, number>>;
  /** Total symbol count. */
  total: number;
}

/**
 * Severity of a single diff entry.
 *
 *   - `breaking`: a public symbol was removed, OR its kind changed in a
 *     way that breaks consumer code (e.g. class → function).
 *   - `additive`: a new symbol was added, OR a non-breaking detail
 *     changed (e.g. moved file within the same package).
 *   - `info`: cosmetic / structural change only.
 */
export type DiffSeverity = 'breaking' | 'additive' | 'info';

export type DiffChangeKind =
  | 'added'
  | 'removed'
  | 'kind-changed'
  | 'moved-file'
  | 'moved-package'
  | 'signature-changed';

export interface IApiSymbolDiff {
  kind: DiffChangeKind;
  severity: DiffSeverity;
  /** Stable, human-readable summary. */
  message: string;
  symbol: IPublicSymbol;
  /** Old version of the symbol for changed entries. */
  previous?: IPublicSymbol;
}

export interface IApiSurfaceDiff {
  schema: typeof API_SURFACE_DIFF_SCHEMA;
  baselineTotal: number;
  currentTotal: number;
  added: number;
  removed: number;
  changed: number;
  /** Total breaking-severity entries. */
  breakingCount: number;
  /** Diff entries, sorted: breaking → additive → info. */
  entries: readonly IApiSymbolDiff[];
}
