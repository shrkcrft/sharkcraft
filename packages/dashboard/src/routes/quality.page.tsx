import { useCallback } from 'react';
import { getCoverage, getDrift, getQuality } from '../api/endpoints.ts';
import { usePollingApi } from '../api/useApi.ts';
import { PageHeader } from '../components/layout/PageHeader.tsx';
import { LoadingState } from '../components/primitives/LoadingState.tsx';
import { ErrorState } from '../components/primitives/ErrorState.tsx';
import { Card } from '../components/primitives/Card.tsx';
import { MetricCard } from '../components/primitives/MetricCard.tsx';
import { ProgressBar } from '../components/primitives/ProgressBar.tsx';
import { CommandBlock } from '../components/primitives/CommandBlock.tsx';
import { gateBadge } from '../utils/status.ts';

export function QualityPage(): JSX.Element {
  const q = useCallback((s: AbortSignal | undefined) => getQuality(s), []);
  const d = useCallback((s: AbortSignal | undefined) => getDrift(s), []);
  const c = useCallback((s: AbortSignal | undefined) => getCoverage(s), []);
  const quality = usePollingApi(q, 15000, true);
  const drift = usePollingApi(d, 30000, true);
  const coverage = usePollingApi(c, 30000, true);

  if (quality.loading && !quality.data) return <LoadingState />;
  if (quality.error) return <ErrorState error={quality.error} onRetry={quality.refetch} />;
  const qd = quality.data!;

  return (
    <>
      <PageHeader title="Quality" subtitle="Gates that decide whether the repo is shippable." />
      <div className="grid grid--3">
        <MetricCard label="Score" value={qd.score} />
        <MetricCard label="Verdict" value={qd.readiness.toUpperCase()} />
        <MetricCard label="Blockers / warnings" value={`${qd.blockers.length} / ${qd.warnings.length}`} />
      </div>

      <section className="section">
        <h2 className="section__title">Gates</h2>
        <table className="table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Status</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {qd.gates.map((g) => {
              const b = gateBadge(g.status);
              return (
                <tr key={g.id}>
                  <td className="mono">{g.id}</td>
                  <td><span className={b.className}>{b.label}</span></td>
                  <td>{g.message ?? ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="section">
        <h2 className="section__title">Coverage</h2>
        {!coverage.data ? (
          <Card><div className="card__hint">Loading…</div></Card>
        ) : (
          <div className="grid grid--2">
            {coverage.data.axes.map((a) => (
              <Card key={a.id} title={a.label} hint={a.missing.length ? `${a.missing.length} missing` : 'no gaps'}>
                <ProgressBar value={a.score} kind={a.score >= 80 ? 'success' : a.score >= 50 ? 'warning' : 'danger'} />
                <div className="card__hint">{a.score}%</div>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section className="section">
        <h2 className="section__title">Drift</h2>
        {!drift.data || drift.data.items.length === 0 ? (
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
              {drift.data.items.map((it) => (
                <tr key={it.id}>
                  <td className="mono">{it.kind}</td>
                  <td>
                    <span className={`badge badge--${it.severity === 'error' ? 'danger' : it.severity === 'warning' ? 'warning' : 'info'}`}>
                      {it.severity}
                    </span>
                  </td>
                  <td>{it.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="section">
        <h2 className="section__title">Recommended commands</h2>
        <div className="grid grid--2">
          <CommandBlock command="shrk quality --strict" purpose="Strict gates (boundaries + drift)" safety="read-only" />
          <CommandBlock command="shrk drift" purpose="Inspect architecture drift" safety="read-only" />
          <CommandBlock command="shrk coverage" purpose="Inspect coverage axes" safety="read-only" />
          <CommandBlock command="shrk report quality --format html --output ./quality.html" purpose="Save the polished HTML report" safety="writes-drafts" />
        </div>
      </section>
    </>
  );
}
