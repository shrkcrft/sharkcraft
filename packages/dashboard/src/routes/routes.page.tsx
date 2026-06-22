import { useCallback, useMemo, useState } from 'react';
import { getRoutes } from '../api/endpoints.ts';
import { useLiveApi } from '../api/useApi.ts';
import { useLiveEvents } from '../api/useLiveEvents.ts';
import { PageHeader } from '../components/layout/PageHeader.tsx';
import { LoadingState } from '../components/primitives/LoadingState.tsx';
import { ErrorState } from '../components/primitives/ErrorState.tsx';
import { Card } from '../components/primitives/Card.tsx';
import { Badge } from '../components/primitives/Badge.tsx';
import { CommandBlock } from '../components/primitives/CommandBlock.tsx';
import { EmptyState } from '../components/primitives/EmptyState.tsx';

function compact(n: number): string {
  return n.toLocaleString();
}

export function RoutesPage(): JSX.Element {
  const live = useLiveEvents();
  const fetcher = useCallback((s: AbortSignal | undefined) => getRoutes(s), []);
  const routesApi = useLiveApi(fetcher, live, ['framework']);
  const [framework, setFramework] = useState<string>('all');
  const [filter, setFilter] = useState('');

  // Every hook must run on every render: keep useMemo ABOVE the loading/error
  // early returns below. Calling it after a conditional return changes the
  // hook count between renders and React throws "Rendered more hooks than
  // during the previous render" (minified #310). Null-safe for pre-data renders.
  const routes = routesApi.data?.routes;
  const filtered = useMemo(() => {
    let rows = routes ?? [];
    if (framework !== 'all') rows = rows.filter((r) => r.framework === framework);
    if (filter) {
      const lc = filter.toLowerCase();
      rows = rows.filter(
        (r) =>
          r.path.toLowerCase().includes(lc) ||
          r.handler.toLowerCase().includes(lc) ||
          r.file.toLowerCase().includes(lc),
      );
    }
    return rows;
  }, [routes, framework, filter]);

  if (routesApi.loading && !routesApi.data) return <LoadingState label="Loading routes…" />;
  if (routesApi.error) return <ErrorState error={routesApi.error} onRetry={routesApi.refetch} />;
  const d = routesApi.data!;

  const frameworks = Object.keys(d.byFramework).sort();

  return (
    <>
      <PageHeader
        title="Routes"
        subtitle="HTTP routes detected across every framework extractor — single table, one source of truth."
      />

      {!d.available ? (
        <EmptyState title="Framework store not built" description={d.hint ?? ''} />
      ) : null}

      <div className="grid grid--3">
        <Card title="Total routes" big={compact(d.total)} hint={`${frameworks.length} frameworks`} />
        <Card title="Frameworks">
          <div>
            {frameworks.map((f) => (
              <Badge key={f}>
                {f}: {compact(d.byFramework[f] ?? 0)}
              </Badge>
            ))}
          </div>
        </Card>
        <Card title="Filter">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <select value={framework} onChange={(e) => setFramework(e.target.value)} style={{ width: '100%' }}>
              <option value="all">All frameworks</option>
              {frameworks.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
            <input
              type="text"
              placeholder="search path / handler / file…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              style={{ width: '100%' }}
            />
          </div>
        </Card>
      </div>

      {filtered.length > 0 ? (
        <section className="section">
          <h2 className="section__title">Routes ({compact(filtered.length)})</h2>
          <table className="table">
            <thead>
              <tr>
                <th>Framework</th>
                <th>Method</th>
                <th>Path</th>
                <th>Handler</th>
                <th>File</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 500).map((r, i) => (
                <tr key={`${r.framework}-${r.method}-${r.path}-${r.file}-${i}`}>
                  <td><Badge>{r.framework}</Badge></td>
                  <td className="mono">{r.method}</td>
                  <td className="mono">{r.path}</td>
                  <td className="mono">{r.handler}</td>
                  <td className="mono">{r.file}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length > 500 ? (
            <div className="card__hint">… showing first 500 of {compact(filtered.length)} rows. Narrow the filter.</div>
          ) : null}
        </section>
      ) : (
        <EmptyState title="No routes match your filter" description="Try changing framework or clearing the search." />
      )}

      <section className="section">
        <h2 className="section__title">Next steps</h2>
        {d.commandHints.map((h) => (
          <CommandBlock key={h.command} command={h.command} purpose={h.purpose} />
        ))}
      </section>
    </>
  );
}
