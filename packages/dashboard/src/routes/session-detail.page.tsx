import { useCallback, useEffect, useState } from 'react';
import { getSession } from '../api/endpoints.ts';
import { useApi } from '../api/useApi.ts';
import { useSessionEvents } from '../api/useSessionEvents.ts';
import { PageHeader } from '../components/layout/PageHeader.tsx';
import { LoadingState } from '../components/primitives/LoadingState.tsx';
import { ErrorState } from '../components/primitives/ErrorState.tsx';
import { EmptyState } from '../components/primitives/EmptyState.tsx';
import { Card } from '../components/primitives/Card.tsx';
import { Badge } from '../components/primitives/Badge.tsx';
import { CommandBlock } from '../components/primitives/CommandBlock.tsx';
import { navigate } from '../utils/routing.ts';
import { formatRelative } from '../utils/format.ts';

export function SessionDetailPage({ id }: { id: string }): JSX.Element {
  const fetcher = useCallback((s: AbortSignal | undefined) => getSession(id, s), [id]);
  const session = useApi(fetcher);
  const events = useSessionEvents(id);
  const [showReport, setShowReport] = useState(false);

  // Refetch session detail whenever an SSE event fires.
  useEffect(() => {
    if (events.version > 0) session.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events.version]);

  if (session.loading && !session.data) return <LoadingState />;
  if (session.error)
    return (
      <>
        <PageHeader title={`Session ${id}`} actions={<button className="btn" onClick={() => navigate('#/sessions')}>← Sessions</button>} />
        <ErrorState error={session.error} onRetry={session.refetch} />
      </>
    );
  const d = session.data!;
  if (!d.available) {
    return (
      <>
        <PageHeader title={`Session ${id}`} actions={<button className="btn" onClick={() => navigate('#/sessions')}>← Sessions</button>} />
        <EmptyState
          title="Session not found"
          description="It may have been archived or never existed."
          command="shrk dev list"
          commandPurpose="List known sessions"
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={d.task ?? id}
        subtitle={
          <span className="mono" style={{ fontSize: 12 }}>
            {id}
          </span>
        }
        actions={
          <>
            <button className="btn" onClick={() => navigate('#/sessions')}>← Sessions</button>
            <button className="btn" onClick={session.refetch}>Refresh</button>
          </>
        }
      />

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16, alignItems: 'center' }}>
        {d.status ? <Badge kind="info">phase: {d.status}</Badge> : null}
        {d.startedAt ? <Badge>started {d.startedAt}</Badge> : null}
        {d.endedAt ? <Badge>ended {d.endedAt}</Badge> : null}
        {events.live ? (
          <Badge kind="success">live</Badge>
        ) : (
          <Badge>polling</Badge>
        )}
        {events.lastEventAt ? (
          <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
            event {formatRelative(events.lastEventAt)}
          </span>
        ) : null}
      </div>

      <section className="section">
        <h2 className="section__title">Next command</h2>
        <div className="grid grid--2">
          {d.commandHints.map((c, i) => (
            <CommandBlock key={i} command={c.command} purpose={c.purpose} safety={c.safety} />
          ))}
        </div>
      </section>

      <section className="section">
        <h2 className="section__title">Plans</h2>
        {(d.plans ?? []).length === 0 ? (
          <Card>
            <div className="card__hint">No plans saved yet. Use <code>shrk dev plan</code>.</div>
          </Card>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Plan</th>
                <th>Path</th>
              </tr>
            </thead>
            <tbody>
              {d.plans!.map((p, i) => (
                <tr key={i}>
                  <td className="mono">{p.id}</td>
                  <td className="mono" style={{ fontSize: 11.5 }}>{p.path}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="section">
        <h2 className="section__title">Artifacts</h2>
        {d.artifacts.length === 0 ? (
          <Card><div className="card__hint">No artifacts yet.</div></Card>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Path</th>
                <th>Format</th>
                <th>Bytes</th>
              </tr>
            </thead>
            <tbody>
              {d.artifacts.map((a) => (
                <tr key={a.id}>
                  <td className="mono" style={{ fontSize: 11.5 }}>{a.id}</td>
                  <td className="mono" style={{ fontSize: 11.5 }}>{a.path}</td>
                  <td>{a.format ?? '—'}</td>
                  <td className="mono" style={{ fontSize: 11.5 }}>{a.bytes ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="section">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <h2 className="section__title" style={{ margin: 0 }}>HTML report preview</h2>
          <button className="btn" onClick={() => setShowReport((s) => !s)}>
            {showReport ? 'Hide' : 'Show inline'}
          </button>
        </div>
        {showReport ? (
          <iframe
            title={`Session ${id} HTML report`}
            src={`/api/sessions/${encodeURIComponent(id)}/report.html`}
            sandbox=""
            style={{
              width: '100%',
              height: 520,
              border: '1px solid var(--border)',
              borderRadius: 6,
              background: 'var(--surface)',
            }}
            data-testid="session-report-iframe"
          />
        ) : (
          <Card>
            <div className="card__hint">
              The rendered HTML report is served read-only at
              {' '}<code>/api/sessions/{id}/report.html</code>. The dashboard
              embeds it in a sandboxed iframe — no scripts, no network, no
              parent access.
            </div>
          </Card>
        )}
      </section>

      <section className="section">
        <Card title="Safety">
          The dashboard does not apply plans. Copy the CLI command and run it intentionally on your machine.
        </Card>
      </section>
    </>
  );
}
