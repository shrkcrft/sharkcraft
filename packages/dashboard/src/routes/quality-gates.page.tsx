import { useCallback } from 'react';
import { getQualityGates } from '../api/endpoints.ts';
import { useLiveApi } from '../api/useApi.ts';
import { useLiveEvents } from '../api/useLiveEvents.ts';
import { PageHeader } from '../components/layout/PageHeader.tsx';
import { LoadingState } from '../components/primitives/LoadingState.tsx';
import { ErrorState } from '../components/primitives/ErrorState.tsx';
import { Card } from '../components/primitives/Card.tsx';
import { Badge } from '../components/primitives/Badge.tsx';
import { CommandBlock } from '../components/primitives/CommandBlock.tsx';

function compact(n: number): string {
  return n.toLocaleString();
}

function badgeKind(status: 'pass' | 'fail' | 'warn' | 'skipped'): 'success' | 'danger' | 'warning' | 'default' {
  if (status === 'pass') return 'success';
  if (status === 'fail') return 'danger';
  if (status === 'warn') return 'warning';
  return 'default';
}

export function QualityGatesPage(): JSX.Element {
  const live = useLiveEvents();
  const fetcher = useCallback((s: AbortSignal | undefined) => getQualityGates(s), []);
  const gates = useLiveApi(fetcher, live, ['quality-gates', 'graph']);

  if (gates.loading && !gates.data) return <LoadingState label="Running quality gates…" />;
  if (gates.error) return <ErrorState error={gates.error} onRetry={gates.refetch} />;
  const d = gates.data!;

  return (
    <>
      <PageHeader
        title={`Quality gates: ${d.overall.toUpperCase()}`}
        subtitle="Live run of the code-intelligence gates against this project."
      />

      <div className="grid grid--4">
        <Card title="Pass" big={compact(d.counts.pass)} />
        <Card title="Warn" big={compact(d.counts.warn)} />
        <Card title="Fail" big={compact(d.counts.fail)} />
        <Card title="Skipped" big={compact(d.counts.skipped)} />
      </div>

      <div className="card__hint">
        Started {d.startedAt} · {compact(d.totalDurationMs)}ms total
      </div>

      <section className="section">
        <h2 className="section__title">Gate results</h2>
        {d.gates.map((g) => (
          <Card key={g.id} title={g.label}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Badge kind={badgeKind(g.status)}>{g.status}</Badge>
              <span className="card__hint mono">{compact(g.durationMs)}ms</span>
            </div>
            <div style={{ marginTop: 8 }}>{g.message}</div>
            {g.nextCommands && g.nextCommands.length > 0 ? (
              <div style={{ marginTop: 12 }}>
                {g.nextCommands.map((c) => (
                  <CommandBlock key={c} command={c} purpose="Suggested follow-up." />
                ))}
              </div>
            ) : null}
          </Card>
        ))}
      </section>

      <section className="section">
        <h2 className="section__title">Next steps</h2>
        {d.commandHints.map((h) => (
          <CommandBlock key={h.command} command={h.command} purpose={h.purpose} />
        ))}
      </section>
    </>
  );
}
