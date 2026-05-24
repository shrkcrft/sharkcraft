import { useCallback } from 'react';
import { getMigrations } from '../api/endpoints.ts';
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

function overallBadgeKind(overall: 'pass' | 'fail' | 'skipped'): 'success' | 'danger' | 'default' {
  if (overall === 'pass') return 'success';
  if (overall === 'fail') return 'danger';
  return 'default';
}

function stepBadgeKind(status: 'pending' | 'planned' | 'applied' | 'failed' | 'skipped'): 'success' | 'danger' | 'warning' | 'default' {
  if (status === 'applied') return 'success';
  if (status === 'failed') return 'danger';
  if (status === 'planned') return 'warning';
  return 'default';
}

export function MigrationsPage(): JSX.Element {
  const live = useLiveEvents();
  const fetcher = useCallback((s: AbortSignal | undefined) => getMigrations(s), []);
  const migrations = useLiveApi(fetcher, live, ['migrations']);

  if (migrations.loading && !migrations.data) return <LoadingState label="Reading migration state…" />;
  if (migrations.error) return <ErrorState error={migrations.error} onRetry={migrations.refetch} />;
  const d = migrations.data!;

  return (
    <>
      <PageHeader
        title="Migrations"
        subtitle="Multi-step migration runs from @shrkcrft/migrate, including any partially-failed checkpoints."
      />

      {!d.available || d.total === 0 ? (
        <EmptyState
          title="No migration runs yet"
          description="Run a migration to populate this panel."
          command="shrk migrate apply <id>"
          commandPurpose="Apply a migration; checkpoints are written after every step."
        />
      ) : null}

      <div className="grid grid--3">
        <Card title="Total migrations" big={compact(d.total)} />
        <Card title="Failed runs" big={compact(d.migrations.filter((m) => m.overall === 'fail').length)} />
        <Card title="Passed runs" big={compact(d.migrations.filter((m) => m.overall === 'pass').length)} />
      </div>

      {d.migrations.map((m) => (
        <section key={m.id} className="section">
          <h2 className="section__title">
            {m.title}{' '}
            <Badge kind={overallBadgeKind(m.overall)}>{m.overall}</Badge>{' '}
            {m.dryRun ? <Badge>dry-run</Badge> : null}{' '}
            {m.resumePoint !== undefined ? <Badge kind="warning">resume @ step {m.resumePoint + 1}</Badge> : null}
          </h2>
          <div className="card__hint">
            <code className="mono">{m.id}</code> · started {m.startedAt} · {compact(m.totalDurationMs)}ms total
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>Step id</th>
                <th>Kind</th>
                <th>Status</th>
                <th>Message</th>
                <th style={{ textAlign: 'right' }}>Duration</th>
              </tr>
            </thead>
            <tbody>
              {m.steps.map((s) => (
                <tr key={`${m.id}-${s.index}`}>
                  <td>{s.index + 1}</td>
                  <td className="mono">{s.id}</td>
                  <td className="mono">{s.kind}</td>
                  <td>
                    <Badge kind={stepBadgeKind(s.status)}>{s.status}</Badge>
                  </td>
                  <td>{s.message}</td>
                  <td style={{ textAlign: 'right' }} className="mono">
                    {compact(s.durationMs)}ms
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}

      <section className="section">
        <h2 className="section__title">Next steps</h2>
        {d.commandHints.map((h) => (
          <CommandBlock key={h.command} command={h.command} purpose={h.purpose} />
        ))}
      </section>
    </>
  );
}
