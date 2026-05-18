import { useCallback } from 'react';
import { getArchitecture } from '../api/endpoints.ts';
import { useApi } from '../api/useApi.ts';
import { PageHeader } from '../components/layout/PageHeader.tsx';
import { LoadingState } from '../components/primitives/LoadingState.tsx';
import { ErrorState } from '../components/primitives/ErrorState.tsx';
import { Card } from '../components/primitives/Card.tsx';
import { MetricCard } from '../components/primitives/MetricCard.tsx';
import { ProgressBar } from '../components/primitives/ProgressBar.tsx';
import { CommandBlock } from '../components/primitives/CommandBlock.tsx';

export function ArchitecturePage(): JSX.Element {
  const fetcher = useCallback((s: AbortSignal | undefined) => getArchitecture(s), []);
  const arch = useApi(fetcher);

  if (arch.loading && !arch.data) return <LoadingState />;
  if (arch.error) return <ErrorState error={arch.error} onRetry={arch.refetch} />;
  const a = arch.data!;

  return (
    <>
      <PageHeader title="Architecture" subtitle="Boundary rules, drift, coverage." />
      <div className="grid grid--3">
        <MetricCard label="Boundary rules" value={a.boundaries.ruleCount} hint="enforced layers" />
        <MetricCard label="Drift findings" value={a.drift.items.length} hint="open" />
        <MetricCard
          label="Coverage avg"
          value={Math.round(a.coverage.axes.reduce((s, x) => s + x.score, 0) / Math.max(a.coverage.axes.length, 1))}
          hint={`${a.coverage.axes.length} axes`}
        />
      </div>

      <section className="section">
        <h2 className="section__title">Boundary violations</h2>
        {a.boundaries.violations.length === 0 ? (
          <Card><div className="card__hint">No active violations.</div></Card>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Rule</th>
                <th>From → To</th>
                <th>Severity</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {a.boundaries.violations.map((v) => (
                <tr key={v.id}>
                  <td className="mono">{v.rule}</td>
                  <td className="mono">{v.from} → {v.to}</td>
                  <td>{v.severity}</td>
                  <td>{v.message ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="section">
        <h2 className="section__title">Drift</h2>
        {a.drift.items.length === 0 ? (
          <Card><div className="card__hint">No drift findings.</div></Card>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Category</th>
                <th>Severity</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {a.drift.items.map((it) => (
                <tr key={it.id}>
                  <td className="mono">{it.kind}</td>
                  <td>{it.severity}</td>
                  <td>{it.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="section">
        <h2 className="section__title">Coverage axes</h2>
        <div className="grid grid--2">
          {a.coverage.axes.map((ax) => (
            <Card key={ax.id} title={ax.label} hint={`${ax.missing.length} missing`}>
              <ProgressBar value={ax.score} kind={ax.score >= 80 ? 'success' : ax.score >= 50 ? 'warning' : 'danger'} />
              <div className="card__hint">{ax.score}%</div>
            </Card>
          ))}
        </div>
      </section>

      <section className="section">
        <h2 className="section__title">Recommended commands</h2>
        <div className="grid grid--2">
          <CommandBlock command="shrk check boundaries" purpose="Enforce layer / import rules" safety="read-only" />
          <CommandBlock command="shrk drift" purpose="Inspect drift findings" safety="read-only" />
          <CommandBlock command="shrk coverage" purpose="Per-axis coverage breakdown" safety="read-only" />
          <CommandBlock command="shrk graph" purpose="Open the relationship graph page" safety="read-only" />
        </div>
      </section>
    </>
  );
}
