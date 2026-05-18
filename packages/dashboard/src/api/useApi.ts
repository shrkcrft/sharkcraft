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
