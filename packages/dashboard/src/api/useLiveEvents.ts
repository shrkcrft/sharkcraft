import { useEffect, useState } from 'react';

export interface ILiveEventsState {
  /** True while the EventSource is open and at least one event has fired. */
  live: boolean;
  /** ISO timestamp of the last change event (or 'hello'). */
  lastEventAt: string | null;
  /** Most recent event name (e.g. `graph`, `framework`, `migrations`). */
  lastEventName: string | null;
  /** Last error message, if the stream failed. */
  error: string | null;
  /** Monotonically increasing counter — bump triggers refetch in consumers. */
  version: number;
}

/**
 * Subscribe to `/api/events` (Server-Sent Events). The server emits
 * `event: change` with `data: <subdir>` (e.g. `graph`, `migrations`)
 * whenever a `.sharkcraft/<subdir>/` file is written.
 *
 * Pure read-only. Consumers should treat `version` as a refetch trigger;
 * the hook itself never fetches resource data.
 */
export function useLiveEvents(): ILiveEventsState {
  const [state, setState] = useState<ILiveEventsState>({
    live: false,
    lastEventAt: null,
    lastEventName: null,
    error: null,
    version: 0,
  });
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    let cancelled = false;
    const es = new EventSource('/api/events');
    const onChange = (ev: MessageEvent): void => {
      if (cancelled) return;
      setState((prev) => ({
        live: true,
        error: null,
        lastEventAt: new Date().toISOString(),
        lastEventName: ev.data ?? null,
        version: prev.version + 1,
      }));
    };
    const onHello = (): void => {
      if (cancelled) return;
      setState((prev) => ({ ...prev, live: true, error: null }));
    };
    const onError = (): void => {
      if (cancelled) return;
      setState((prev) => ({ ...prev, live: false, error: 'connection lost' }));
    };
    es.addEventListener('hello', onHello);
    es.addEventListener('change', onChange as EventListener);
    es.addEventListener('error', onError);
    return () => {
      cancelled = true;
      es.close();
    };
  }, []);
  return state;
}

/**
 * Convenience: returns `true` exactly when `useLiveEvents.version`
 * changes. Combine with `useEffect` in a page to refetch.
 */
export function useEventVersion(): number {
  return useLiveEvents().version;
}
