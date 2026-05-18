import { useCallback, useMemo, useState } from 'react';
import { getGraph, getGraphNode, getGraphWhy } from '../api/endpoints.ts';
import { useApi } from '../api/useApi.ts';
import { PageHeader } from '../components/layout/PageHeader.tsx';
import { LoadingState } from '../components/primitives/LoadingState.tsx';
import { ErrorState } from '../components/primitives/ErrorState.tsx';
import { Card } from '../components/primitives/Card.tsx';
import { Badge } from '../components/primitives/Badge.tsx';
import { CommandBlock } from '../components/primitives/CommandBlock.tsx';
import { GraphSvg } from '../components/domain/GraphSvg.tsx';
import type { IDashboardGraphNodeResponse, IDashboardGraphPathResponse } from '../api/types.ts';

const KINDS = ['rule', 'path', 'template', 'pipeline', 'preset', 'pack', 'boundary', 'knowledge', 'doc'] as const;

export function GraphPage(): JSX.Element {
  const fetcher = useCallback((s: AbortSignal | undefined) => getGraph(s), []);
  const graph = useApi(fetcher);
  const [filter, setFilter] = useState('');
  const [kind, setKind] = useState<string>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [node, setNode] = useState<IDashboardGraphNodeResponse | null>(null);
  const [whyFrom, setWhyFrom] = useState('');
  const [whyTo, setWhyTo] = useState('');
  const [whyResult, setWhyResult] = useState<IDashboardGraphPathResponse | null>(null);
  const [whyError, setWhyError] = useState<string | null>(null);
  const [view, setView] = useState<'list' | 'graph'>('list');

  const filtered = useMemo(() => {
    const nodes = graph.data?.nodes ?? [];
    return nodes.filter((n) => {
      if (kind !== 'all' && n.kind !== kind) return false;
      if (filter && !`${n.id} ${n.label ?? ''}`.toLowerCase().includes(filter.toLowerCase())) return false;
      return true;
    }).slice(0, 200);
  }, [graph.data, filter, kind]);

  const filteredEdges = useMemo(() => {
    if (!graph.data) return [];
    const ids = new Set(filtered.map((n) => n.id));
    return graph.data.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  }, [graph.data, filtered]);

  const selectNode = async (id: string): Promise<void> => {
    setSelectedId(id);
    try {
      const r = await getGraphNode(id);
      setNode(r.data);
    } catch {
      setNode(null);
    }
  };

  const runWhy = async (): Promise<void> => {
    setWhyError(null);
    if (!whyFrom || !whyTo) return;
    try {
      const r = await getGraphWhy(whyFrom, whyTo);
      setWhyResult(r.data);
    } catch (e) {
      setWhyError((e as Error).message);
    }
  };

  if (graph.loading && !graph.data) return <LoadingState />;
  if (graph.error) return <ErrorState error={graph.error} onRetry={graph.refetch} />;

  return (
    <>
      <PageHeader
        title="Knowledge graph"
        subtitle="Relationships between rules, templates, paths, packs, etc."
        actions={
          <div className="tabs" style={{ margin: 0, border: 'none' }}>
            <button
              className={`tabs__tab${view === 'list' ? ' tabs__tab--active' : ''}`}
              onClick={() => setView('list')}
              type="button"
            >
              List
            </button>
            <button
              className={`tabs__tab${view === 'graph' ? ' tabs__tab--active' : ''}`}
              onClick={() => setView('graph')}
              type="button"
            >
              Graph
            </button>
          </div>
        }
      />

      <div style={{ display: 'flex', gap: 10, marginBottom: 14, alignItems: 'center' }}>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search nodes…"
          style={{ flex: 1, background: 'var(--surface-elevated)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 6, padding: '7px 10px' }}
        />
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          style={{ background: 'var(--surface-elevated)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 6, padding: '7px 10px' }}
        >
          <option value="all">All kinds</option>
          {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>
          {filtered.length} nodes · {filteredEdges.length} edges
        </span>
      </div>

      {view === 'graph' ? (
        <Card>
          <GraphSvg
            nodes={filtered}
            edges={filteredEdges}
            selectedId={selectedId}
            onSelect={(id) => selectNode(id)}
          />
          <div className="card__hint" style={{ marginTop: 8 }}>
            Click a node to load its inbound/outbound edges below. Nodes are
            colored by kind; ring layout (best for ≤ ~80 visible nodes — narrow
            the filter for clarity).
          </div>
        </Card>
      ) : null}

      <div className="grid" style={{ gridTemplateColumns: '2fr 3fr', marginTop: view === 'graph' ? 18 : 0 }}>
        <Card title={`Nodes (${filtered.length})`}>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, maxHeight: 420, overflowY: 'auto' }}>
            {filtered.map((n) => (
              <li
                key={`${n.kind}:${n.id}`}
                style={{ padding: '6px 0', cursor: 'pointer', display: 'flex', justifyContent: 'space-between' }}
                onClick={() => selectNode(n.id)}
              >
                <span className="mono">{n.id}</span>
                <Badge>{n.kind}</Badge>
              </li>
            ))}
          </ul>
        </Card>

        <Card title={node ? `Node: ${node.id}` : 'Select a node'}>
          {!node ? (
            <div className="card__hint">Click a node on the left to see its edges.</div>
          ) : !node.found ? (
            <div className="card__hint">Not found.</div>
          ) : (
            <>
              <div style={{ marginBottom: 10 }}>
                <Badge>{node.node!.kind}</Badge> <span className="mono">{node.node!.label ?? node.node!.id}</span>
              </div>
              <div className="grid grid--2">
                <div>
                  <div className="card__title">Inbound</div>
                  {node.inbound.length === 0 ? (
                    <div className="card__hint">none</div>
                  ) : (
                    <ul style={{ paddingLeft: 16 }}>
                      {node.inbound.map((e, i) => <li key={i} className="mono">{e.from} ({e.kind})</li>)}
                    </ul>
                  )}
                </div>
                <div>
                  <div className="card__title">Outbound</div>
                  {node.outbound.length === 0 ? (
                    <div className="card__hint">none</div>
                  ) : (
                    <ul style={{ paddingLeft: 16 }}>
                      {node.outbound.map((e, i) => <li key={i} className="mono">→ {e.to} ({e.kind})</li>)}
                    </ul>
                  )}
                </div>
              </div>
            </>
          )}
          {selectedId ? (
            <div style={{ marginTop: 10 }}>
              <CommandBlock command={`shrk graph node ${selectedId}`} purpose="Inspect this node in the CLI" safety="read-only" />
            </div>
          ) : null}
        </Card>
      </div>

      <section className="section">
        <h2 className="section__title">Graph &quot;why&quot;</h2>
        <Card>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input placeholder="from id" value={whyFrom} onChange={(e) => setWhyFrom(e.target.value)} style={{ background: 'var(--surface-elevated)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 6, padding: '7px 10px' }} />
            <input placeholder="to id" value={whyTo} onChange={(e) => setWhyTo(e.target.value)} style={{ background: 'var(--surface-elevated)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 6, padding: '7px 10px' }} />
            <button className="btn btn--primary" onClick={runWhy}>Find path</button>
          </div>
          {whyError ? <div className="error" style={{ marginTop: 10 }}>{whyError}</div> : null}
          {whyResult ? (
            <div style={{ marginTop: 10 }}>
              {!whyResult.found ? (
                <div className="card__hint">No path. {whyResult.explanation ?? ''}</div>
              ) : (
                <pre className="json">{(whyResult.path ?? []).join('\n  → ')}</pre>
              )}
            </div>
          ) : null}
        </Card>
      </section>
    </>
  );
}
