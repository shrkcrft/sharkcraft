/**
 * Typed dashboard API client. Wraps fetch, unwraps the v1 envelope, and
 * surfaces typed errors. Stateless — callers wire it through useApi.
 */
import type { IDashboardApiEnvelope } from '@shrkcrft/dashboard-api';

const ENVELOPE_SCHEMA = 'sharkcraft.dashboard-api/v1';

export interface IRawApiResponse<T> {
  data: T;
  generatedAt: string;
  projectRoot: string;
  warnings: readonly string[];
  commandHints: readonly string[];
}

export class DashboardApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = 'DashboardApiError';
  }
}

export function buildUrl(path: string, params?: Record<string, string | undefined>): string {
  const url = new URL(path, window.location.origin);
  if (params) {
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  }
  return url.pathname + url.search;
}

export async function apiGet<T>(
  path: string,
  params?: Record<string, string | undefined>,
  signal?: AbortSignal,
): Promise<IRawApiResponse<T>> {
  const url = buildUrl(path, params);
  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', signal });
  } catch (err) {
    throw new DashboardApiError(0, 'network', (err as Error).message || 'network error');
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new DashboardApiError(res.status, 'invalid-json', `Non-JSON response from ${path}`);
  }
  if (!res.ok) {
    const errBody = body as { data?: { error?: string; code?: string } };
    const code = errBody?.data?.code ?? 'unknown';
    const message = errBody?.data?.error ?? `HTTP ${res.status}`;
    throw new DashboardApiError(res.status, code, message);
  }
  const env = body as IDashboardApiEnvelope<T>;
  if (env.schema !== ENVELOPE_SCHEMA) {
    throw new DashboardApiError(res.status, 'schema-mismatch', `Unexpected schema ${env.schema}`);
  }
  return {
    data: env.data,
    generatedAt: env.generatedAt,
    projectRoot: env.projectRoot,
    warnings: env.warnings ?? [],
    commandHints: env.commandHints ?? [],
  };
}
