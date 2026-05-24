import { useCallback, useEffect, useRef, useState } from 'react';
import { DashboardApiError, type IRawApiResponse } from './client.ts';

export interface IUseApiResult<T> {
  data: T | null;
  error: DashboardApiError | null;
  loading: boolean;
  generatedAt: string | null;
  projectRoot: string | null;
  warnings: readonly string[];
  refetch: () => void;
}

export type ApiFetcher<T> = (signal?: AbortSignal) => Promise<IRawApiResponse<T>>;

export function useApi<T>(fetcher: ApiFetcher<T>): IUseApiResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<DashboardApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [projectRoot, setProjectRoot] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<readonly string[]>([]);
  const [tick, setTick] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    fetcherRef
      .current(ac.signal)
      .then((res) => {
        if (ac.signal.aborted) return;
        setData(res.data);
        setGeneratedAt(res.generatedAt);
        setProjectRoot(res.projectRoot);
        setWarnings(res.warnings);
        setError(null);
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted) return;
        setError(e instanceof DashboardApiError ? e : new DashboardApiError(0, 'unknown', String(e)));
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
    return () => ac.abort();
  }, [tick]);

  const refetch = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, generatedAt, projectRoot, warnings, refetch };
}

export function usePollingApi<T>(fetcher: ApiFetcher<T>, intervalMs = 5000, enabled = true): IUseApiResult<T> {
  const base = useApi(fetcher);
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => base.refetch(), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs, enabled, base.refetch]);
  return base;
}

/**
 * Like `useApi`, but refetches whenever the live-events `version`
 * counter advances. Pair with `useLiveEvents` in pages that want to
 * mirror on-disk store changes without polling.
 *
 * Pass an optional `eventFilter` to scope refetches to specific
 * `.sharkcraft/<subdir>/` writes — e.g. the Migrations page only
 * cares about `migrations`, so an event for `graph` shouldn't trigger
 * a refetch.
 */
export function useLiveApi<T>(
  fetcher: ApiFetcher<T>,
  live: { version: number; lastEventName: string | null },
  eventFilter?: readonly string[],
): IUseApiResult<T> {
  const base = useApi(fetcher);
  useEffect(() => {
    // Skip the initial render — useApi already fired its first fetch.
    if (live.version === 0) return;
    if (eventFilter && live.lastEventName && !eventFilter.includes(live.lastEventName)) return;
    base.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.version, base.refetch]);
  return base;
}
