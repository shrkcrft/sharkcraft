/**
 * Shared dashboard-API value objects. These are intentionally lossy summaries
 * — full inspection data lives in @shrkcrft/inspector. The dashboard just
 * needs stable, JSON-serializable shapes.
 */

export interface IDashboardArtifactRef {
  /** Short identifier (e.g. "adoption-state", "session-html"). */
  readonly id: string;
  /** Human-readable label. */
  readonly title?: string;
  /** Absolute or project-relative path. */
  readonly path: string;
  /** Whether the artifact exists on disk right now. */
  readonly exists: boolean;
  /** Bytes if known. */
  readonly bytes?: number;
  /** ISO timestamp of last modification if known. */
  readonly modifiedAt?: string;
  /** MIME-ish hint (e.g. text/markdown, text/html, application/json). */
  readonly format?: 'text' | 'markdown' | 'html' | 'json' | 'patch' | 'binary';
}

export type DashboardSafetyLevel =
  | 'read-only'
  | 'writes-drafts'
  | 'writes-source'
  | 'runs-shell'
  | 'destructive'
  | 'unknown';

export interface IDashboardSafetyTag {
  readonly level: DashboardSafetyLevel;
  readonly note?: string;
}

export interface IDashboardCommandHint {
  /** Copy-pasteable command line. */
  readonly command: string;
  /** Short description shown next to the command. */
  readonly purpose: string;
  readonly safety?: DashboardSafetyLevel;
}

export interface IDashboardCount {
  readonly label: string;
  readonly value: number;
  readonly hint?: string;
}

export interface IDashboardSection<T> {
  readonly available: boolean;
  readonly summary?: string;
  readonly items?: readonly T[];
  readonly counts?: readonly IDashboardCount[];
  readonly artifacts?: readonly IDashboardArtifactRef[];
  readonly commandHints?: readonly IDashboardCommandHint[];
  readonly warnings?: readonly string[];
}
