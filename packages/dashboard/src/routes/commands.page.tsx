import { useCallback, useMemo, useState } from 'react';
import { getCommands } from '../api/endpoints.ts';
import { useApi } from '../api/useApi.ts';
import { PageHeader } from '../components/layout/PageHeader.tsx';
import { LoadingState } from '../components/primitives/LoadingState.tsx';
import { ErrorState } from '../components/primitives/ErrorState.tsx';
import { CommandBlock } from '../components/primitives/CommandBlock.tsx';
import { safetyToBadge } from '../utils/status.ts';

export function CommandsPage(): JSX.Element {
  const fetcher = useCallback((s: AbortSignal | undefined) => getCommands(s), []);
  const commands = useApi(fetcher);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [safety, setSafety] = useState('all');

  const filtered = useMemo(() => {
    const cmds = commands.data?.commands ?? [];
    return cmds.filter((c) => {
      if (search && !`${c.id} ${c.description ?? ''}`.toLowerCase().includes(search.toLowerCase())) return false;
      if (category !== 'all' && c.group !== category) return false;
      if (safety !== 'all' && c.safety.level !== safety) return false;
      return true;
    });
  }, [commands.data, search, category, safety]);

  if (commands.loading && !commands.data) return <LoadingState />;
  if (commands.error) return <ErrorState error={commands.error} onRetry={commands.refetch} />;
  const groups = commands.data?.groups ?? [];

  return (
    <>
      <PageHeader title="Commands" subtitle={`${commands.data?.commands.length ?? 0} commands.`} />

      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search…"
          style={{ flex: 1, minWidth: 200, background: 'var(--surface-elevated)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 6, padding: '7px 10px' }}
        />
        <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ background: 'var(--surface-elevated)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 6, padding: '7px 10px' }}>
          <option value="all">All categories</option>
          {groups.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
        </select>
        <select value={safety} onChange={(e) => setSafety(e.target.value)} style={{ background: 'var(--surface-elevated)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 6, padding: '7px 10px' }}>
          <option value="all">All safety levels</option>
          <option value="read-only">read-only</option>
          <option value="writes-drafts">writes-drafts</option>
          <option value="writes-source">writes-source</option>
          <option value="runs-shell">runs-shell</option>
        </select>
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>Command</th>
            <th>Description</th>
            <th>Category</th>
            <th>Safety</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {filtered.map((c) => {
            const b = safetyToBadge(c.safety.level);
            return (
              <tr key={c.id}>
                <td className="mono">{c.id}</td>
                <td>{c.description}</td>
                <td>{c.group}</td>
                <td><span className={b.className}>{b.label}</span></td>
                <td style={{ minWidth: 280 }}>
                  <CommandBlock command={`shrk ${c.id}`} safety={c.safety.level} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
