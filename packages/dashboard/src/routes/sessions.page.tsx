import { useCallback, useMemo, useState } from 'react';
import { getSessions } from '../api/endpoints.ts';
import { usePollingApi } from '../api/useApi.ts';
import { PageHeader } from '../components/layout/PageHeader.tsx';
import { LoadingState } from '../components/primitives/LoadingState.tsx';
import { ErrorState } from '../components/primitives/ErrorState.tsx';
import { EmptyState } from '../components/primitives/EmptyState.tsx';
import { Badge } from '../components/primitives/Badge.tsx';
import { navigate } from '../utils/routing.ts';

export function SessionsPage(): JSX.Element {
  const fetcher = useCallback((s: AbortSignal | undefined) => getSessions(s), []);
  const sessions = usePollingApi(fetcher, 5000, true);
  const [search, setSearch] = useState('');
  const [phaseFilter, setPhaseFilter] = useState<string>('all');

  const filtered = useMemo(() => {
    const list = sessions.data?.sessions ?? [];
    return list.filter((s) => {
      if (phaseFilter !== 'all' && s.status !== phaseFilter) return false;
      if (search && !`${s.id} ${s.task ?? ''}`.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [sessions.data, phaseFilter, search]);

  const phases = useMemo(() => {
    const set = new Set<string>();
    for (const s of sessions.data?.sessions ?? []) if (s.status) set.add(s.status);
    return Array.from(set);
  }, [sessions.data]);

  if (sessions.loading && !sessions.data) return <LoadingState />;
  if (sessions.error) return <ErrorState error={sessions.error} onRetry={sessions.refetch} />;

  return (
    <>
      <PageHeader
        title="Dev sessions"
        subtitle="AI-safe dev workflow state under .sharkcraft/sessions/."
      />
      <div style={{ display: 'flex', gap: 10, marginBottom: 14, alignItems: 'center' }}>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search id or task…"
          style={{
            flex: 1,
            background: 'var(--surface-elevated)',
            border: '1px solid var(--border)',
            color: 'var(--text)',
            borderRadius: 6,
            padding: '7px 10px',
            fontSize: 13,
          }}
        />
        <select
          value={phaseFilter}
          onChange={(e) => setPhaseFilter(e.target.value)}
          style={{
            background: 'var(--surface-elevated)',
            border: '1px solid var(--border)',
            color: 'var(--text)',
            borderRadius: 6,
            padding: '7px 10px',
            fontSize: 13,
          }}
        >
          <option value="all">All phases</option>
          {phases.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title={sessions.data?.sessions.length === 0 ? 'No sessions yet' : 'No matches'}
          description={
            sessions.data?.sessions.length === 0
              ? 'Sessions persist plan → review → apply → validate loops.'
              : undefined
          }
          command={sessions.data?.sessions.length === 0 ? 'shrk dev start "describe your task"' : undefined}
          commandPurpose="Start an AI-safe dev session"
        />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Task</th>
              <th>Phase</th>
              <th>Started</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {filtered.map((s) => (
              <tr key={s.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`#/sessions/${s.id}`)}>
                <td className="mono" style={{ fontSize: 11.5 }}>{s.id}</td>
                <td>{s.task ?? '—'}</td>
                <td>{s.status ? <Badge kind="info">{s.status}</Badge> : '—'}</td>
                <td className="mono" style={{ fontSize: 11.5 }}>{s.startedAt ?? '—'}</td>
                <td>
                  <a onClick={(e) => e.stopPropagation()} href={`#/sessions/${s.id}`}>
                    Open →
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
