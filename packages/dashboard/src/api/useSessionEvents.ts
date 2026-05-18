import { useEffect, useState } from 'react';

export interface ISessionEventsState {
  /** True while the EventSource is open and at least one event has fired. */
  live: boolean;
  /** ISO timestamp of the last change event (or 'hello'). */
  lastEventAt: string | null;
  /** Last error message, if the stream failed. */
  error: string | null;
  /** Monotonically increasing counter — bump triggers refetch in consumers. */
  version: number;
}

/**
 * Subscribe to `/api/sessions/:id/events` (Server-Sent Events). Pure read-only.
 * Consumers should treat `version` as a refetch trigger; the hook itself
 * never fetches resource data.
 */
export function useSessionEvents(id: string | null): ISessionEventsState {
  const [state, setState] = useState<ISessionEventsState>({
    live: false,
    lastEventAt: null,
    error: null,
    version: 0,
  });
  useEffect(() => {
    if (!id) return;
    if (typeof EventSource === 'undefined') return;
    let cancelled = false;
    const url = `/api/sessions/${encodeURIComponent(id)}/events`;
    const es = new EventSource(url);
    const onAny = (): void => {
      if (cancelled) return;
      setState((prev) => ({
        live: true,
        error: null,
        lastEventAt: new Date().toISOString(),
        version: prev.version + 1,
      }));
    };
    const onError = (): void => {
      if (cancelled) return;
      setState((prev) => ({ ...prev, live: false, error: 'connection lost' }));
    };
    es.addEventListener('hello', onAny);
    es.addEventListener('change', onAny);
    es.addEventListener('error', onError);
    return () => {
      cancelled = true;
      es.close();
    };
  }, [id]);
  return state;
}
