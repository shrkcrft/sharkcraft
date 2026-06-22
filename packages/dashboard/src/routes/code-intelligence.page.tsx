import { useCallback } from 'react';
import { getCodeIntelligence } from '../api/endpoints.ts';
import { useLiveApi } from '../api/useApi.ts';
import { useLiveEvents } from '../api/useLiveEvents.ts';
import { PageHeader } from '../components/layout/PageHeader.tsx';
import { LoadingState } from '../components/primitives/LoadingState.tsx';
import { ErrorState } from '../components/primitives/ErrorState.tsx';
import { Card } from '../components/primitives/Card.tsx';
import { Badge } from '../components/primitives/Badge.tsx';
import { CommandBlock } from '../components/primitives/CommandBlock.tsx';
import { EmptyState } from '../components/primitives/EmptyState.tsx';

function compact(n: number | undefined): string {
  return (n ?? 0).toLocaleString();
}

export function CodeIntelligencePage(): JSX.Element {
  const live = useLiveEvents();
  const fetcher = useCallback((s: AbortSignal | undefined) => getCodeIntelligence(s), []);
  const ci = useLiveApi(fetcher, live, ['graph', 'bridge', 'framework']);

  if (ci.loading && !ci.data) return <LoadingState label="Reading code-intelligence stores…" />;
  if (ci.error) return <ErrorState error={ci.error} onRetry={ci.refetch} />;
  const d = ci.data!;

  return (
    <>
      <PageHeader
        title="Code intelligence"
        subtitle="Aggregated view of the graph, bridge, framework, and architecture stores."
      />

      {!d.available ? (
        <EmptyState
          title="No code-intelligence stores yet"
          description="Run the indexers to populate the on-disk stores."
        />
      ) : null}

      <div className="grid grid--2">
        <Card title="Code graph">
          {d.graph.available ? (
            <>
              <div className="grid grid--2" style={{ marginTop: 8 }}>
                <Card title="Files indexed" big={compact(d.graph.fileCount)} hint={`${d.graph.workspacePackages ?? 0} packages`} />
                <Card title="Nodes" big={compact(d.graph.nodeCount)} hint={`${compact(d.graph.edgeCount)} edges`} />
              </div>
              {d.graph.lastIndexedAt ? (
                <div className="card__hint" style={{ marginTop: 8 }}>
                  Last indexed: <code className="mono">{d.graph.lastIndexedAt}</code>
                </div>
              ) : null}
              {d.graph.freshness ? (
                <div style={{ marginTop: 8 }}>
                  <Badge kind={freshnessKind(d.graph.freshness.state)}>{freshnessLabel(d.graph.freshness)}</Badge>
                </div>
              ) : null}
              {d.graph.nodesByKind ? (
                <div style={{ marginTop: 12 }}>
                  {Object.entries(d.graph.nodesByKind)
                    .filter(([, v]) => v > 0)
                    .map(([k, v]) => (
                      <Badge key={k}>
                        {k}: {compact(v)}
                      </Badge>
                    ))}
                </div>
              ) : null}
            </>
          ) : (
            <EmptyState title="Graph not indexed" description={d.graph.hint ?? ''} />
          )}
        </Card>

        <Card title="Rule-graph bridge">
          {d.bridge.available ? (
            <>
              <div className="grid grid--3">
                {d.bridge.sourceCounts
                  ? Object.entries(d.bridge.sourceCounts).map(([k, v]) => (
                      <Card key={k} title={k} big={compact(v)} />
                    ))
                  : null}
              </div>
              {d.bridge.lastBuiltAt ? (
                <div className="card__hint" style={{ marginTop: 8 }}>
                  Last built: <code className="mono">{d.bridge.lastBuiltAt}</code>
                </div>
              ) : null}
            </>
          ) : (
            <EmptyState title="Bridge not built" description={d.bridge.hint ?? ''} />
          )}
        </Card>

        <Card title="Framework entities">
          {d.framework.available ? (
            <>
              <div className="grid grid--3">
                {d.framework.countsByFramework
                  ? Object.entries(d.framework.countsByFramework).map(([k, v]) => (
                      <Card key={k} title={k} big={compact(v)} />
                    ))
                  : null}
              </div>
              {d.framework.lastBuiltAt ? (
                <div className="card__hint" style={{ marginTop: 8 }}>
                  Last built: <code className="mono">{d.framework.lastBuiltAt}</code>
                </div>
              ) : null}
            </>
          ) : (
            <EmptyState title="Framework store not built" description={d.framework.hint ?? ''} />
          )}
        </Card>

        <Card title="Architecture checks">
          {d.architecture.available ? (
            <>
              <div className="grid grid--2">
                <Card title="Errors" big={compact(d.architecture.errors)} />
                <Card title="Warnings" big={compact(d.architecture.warnings)} />
              </div>
              {d.architecture.violationsByKind ? (
                <div style={{ marginTop: 12 }}>
                  {Object.entries(d.architecture.violationsByKind)
                    .filter(([, v]) => v > 0)
                    .map(([k, v]) => (
                      <Badge key={k}>
                        {k}: {compact(v)}
                      </Badge>
                    ))}
                </div>
              ) : null}
            </>
          ) : (
            <EmptyState title="Architecture-guard skipped" description={d.architecture.hint ?? ''} />
          )}
        </Card>
      </div>

      {d.graph.hubs && (d.graph.hubs.symbols.length > 0 || d.graph.hubs.files.length > 0) ? (
        <section className="section">
          <h2 className="section__title">Load-bearing code</h2>
          <p className="section__subtitle">
            The most-depended-on symbols and files — change these most carefully. In-degree counts
            distinct dependent files.
          </p>
          <div className="grid grid--2">
            <Card title="Most-referenced symbols">
              <HubList rows={d.graph.hubs.symbols} empty="No referenced symbols (TS/JS call graph only)." />
            </Card>
            <Card title="Most-imported files">
              <HubList rows={d.graph.hubs.files} empty="No imported files yet." />
            </Card>
          </div>
        </section>
      ) : null}

      <section className="section">
        <h2 className="section__title">Next steps</h2>
        {d.commandHints.map((h) => (
          <CommandBlock key={h.command} command={h.command} purpose={h.purpose} />
        ))}
      </section>
    </>
  );
}

function freshnessKind(state: 'fresh' | 'stale' | 'corrupt'): 'success' | 'warning' | 'danger' {
  return state === 'fresh' ? 'success' : state === 'stale' ? 'warning' : 'danger';
}

function freshnessLabel(f: { state: 'fresh' | 'stale' | 'corrupt'; modified: number; added: number; deleted: number }): string {
  if (f.state === 'corrupt') return 'index corrupt — run shrk graph index';
  if (f.state === 'fresh') return 'index fresh';
  const behind = f.modified + f.added + f.deleted;
  return `index stale — ${behind} file(s) behind (${f.modified} modified, ${f.added} new, ${f.deleted} deleted)`;
}

function HubList({
  rows,
  empty,
}: {
  rows: readonly { id: string; label: string; path?: string; inDegree: number }[];
  empty: string;
}): JSX.Element {
  if (rows.length === 0) return <div className="card__hint">{empty}</div>;
  return (
    <ol className="hub-list" style={{ margin: '8px 0 0', paddingLeft: 20 }}>
      {rows.map((r) => (
        <li key={r.id} style={{ marginBottom: 4 }}>
          <code className="mono">{r.label}</code>{' '}
          <Badge kind="info">{r.inDegree}</Badge>
          {r.path ? <div className="card__hint">{r.path}</div> : null}
        </li>
      ))}
    </ol>
  );
}
