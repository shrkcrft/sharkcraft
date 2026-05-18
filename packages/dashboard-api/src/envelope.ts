/**
 * Stable envelope shared by every dashboard API response.
 *
 * Wire schema id: `sharkcraft.dashboard-api/v1`. Future breaking changes bump
 * the major in the id. Adding new optional fields to `data` is non-breaking.
 */
export const DASHBOARD_API_SCHEMA_ID = 'sharkcraft.dashboard-api/v1';

export type IDashboardApiSchemaId = typeof DASHBOARD_API_SCHEMA_ID;

export interface IDashboardApiEnvelope<T> {
  /** Stable schema marker. */
  readonly schema: IDashboardApiSchemaId;
  /** ISO-8601 timestamp of when the response was produced. */
  readonly generatedAt: string;
  /** Absolute path to the project root the response describes. */
  readonly projectRoot: string;
  /** Optional commands the user can copy/paste to act on this view. */
  readonly commandHints?: readonly string[];
  /** Non-fatal warnings — missing artifacts, partial data, etc. */
  readonly warnings?: readonly string[];
  /** Whether the payload reflects a feature that has data yet. */
  readonly available?: boolean;
  /** Optional API-version field shared with `/api/health` for clients. */
  readonly apiVersion?: string;
  /** The payload itself. */
  readonly data: T;
}

/** Helper to construct a response envelope without forgetting the schema id. */
export function makeDashboardEnvelope<T>(args: {
  projectRoot: string;
  data: T;
  generatedAt?: string;
  commandHints?: readonly string[];
  warnings?: readonly string[];
  available?: boolean;
  apiVersion?: string;
}): IDashboardApiEnvelope<T> {
  return {
    schema: DASHBOARD_API_SCHEMA_ID,
    generatedAt: args.generatedAt ?? new Date().toISOString(),
    projectRoot: args.projectRoot,
    commandHints: args.commandHints,
    warnings: args.warnings,
    available: args.available,
    apiVersion: args.apiVersion,
    data: args.data,
  };
}
