import { useCallback } from 'react';
import { getAdoption, getOverview, getPacks, getQuality, getSafety, getSessions, getStats } from '../api/endpoints.ts';
import { usePollingApi } from '../api/useApi.ts';
import { Card } from '../components/primitives/Card.tsx';
import { Badge } from '../components/primitives/Badge.tsx';
import { MetricCard } from '../components/primitives/MetricCard.tsx';
import { CommandBlock } from '../components/primitives/CommandBlock.tsx';
import { LoadingState } from '../components/primitives/LoadingState.tsx';
import { ErrorState } from '../components/primitives/ErrorState.tsx';
import { EmptyState } from '../components/primitives/EmptyState.tsx';
import { freshnessBadge } from '../utils/status.ts';
import { ProgressBar } from '../components/primitives/ProgressBar.tsx';
import { PageHeader } from '../components/layout/PageHeader.tsx';
import { navigate } from '../utils/routing.ts';

export function OverviewPage(): JSX.Element {
  const overviewFetch = useCallback((s: AbortSignal | undefined) => getOverview(s), []);
  const qualityFetch = useCallback((s: AbortSignal | undefined) => getQuality(s), []);
  const safetyFetch = useCallback((s: AbortSignal | undefined) => getSafety(s), []);
  const sessionsFetch = useCallback((s: AbortSignal | undefined) => getSessions(s), []);
  const packsFetch = useCallback((s: AbortSignal | undefined) => getPacks(s), []);
  const adoptionFetch = useCallback((s: AbortSignal | undefined) => getAdoption(s), []);
  const statsFetch = useCallback((s: AbortSignal | undefined) => getStats(s, { top: 0 }), []);
  const overview = usePollingApi(overviewFetch, 10000, true);
  const quality = usePollingApi(qualityFetch, 15000, true);
  const safety = usePollingApi(safetyFetch, 30000, true);
  const sessions = usePollingApi(sessionsFetch, 5000, true);
  const packs = usePollingApi(packsFetch, 30000, true);
  const adoption = usePollingApi(adoptionFetch, 15000, true);
  const stats = usePollingApi(statsFetch, 60000, true);

  if (overview.loading && !overview.data) return <LoadingState label="Loading overview…" />;
  if (overview.error) return <ErrorState error={overview.error} onRetry={overview.refetch} />;
  const o = overview.data!;

  const qualityVerdict =
    quality.data?.readiness === 'pass'
      ? { kind: 'success' as const, label: 'pass' }
      : quality.data?.readiness === 'fail'
        ? { kind: 'danger' as const, label: 'fail' }
        : { kind: 'warning' as const, label: quality.data?.readiness ?? '—' };

  const unsignedPacks = packs.data?.packs.filter((p) => !p.signed) ?? [];
  const recentSessions = sessions.data?.sessions.slice(0, 5) ?? [];
  const fresh = freshnessBadge(adoption.data?.state?.freshness.status);

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle="Repo health, safety posture, and the next safe command."
      />

      <div className="grid grid--5">
        <MetricCard
          label="AI Readiness"
          value={o.readiness.score}
          hint={o.readiness.verdict}
        />
        <MetricCard
          label="Quality"
          value={quality.data?.score ?? '—'}
          badge={<span style={{ marginLeft: 6 }} className={`badge badge--${qualityVerdict.kind}`}>{qualityVerdict.label}</span>}
          hint={`${quality.data?.blockers.length ?? 0} blockers, ${quality.data?.warnings.length ?? 0} warnings`}
        />
        <MetricCard
          label="Safety"
          value={safety.data?.mcpReadOnly ? 'PASS' : 'CHECK'}
          badge={
            <span
              className={`badge badge--${safety.data?.mcpReadOnly ? 'success' : 'danger'}`}
              style={{ marginLeft: 6 }}
            >
              MCP {safety.data?.mcpReadOnly ? 'read-only' : 'writable'}
            </span>
          }
          hint={`${safety.data?.writeCapableCommands.length ?? 0} write-capable cmds`}
        />
        <MetricCard
          label="Sessions"
          value={sessions.data?.sessions.length ?? 0}
          hint="active dev sessions"
        />
        <div onClick={() => navigate('#/stats')} style={{ cursor: 'pointer' }}>
          <MetricCard
            label="Repo size"
            value={stats.data ? stats.data.totals.files.toLocaleString() : '—'}
            hint={
              stats.data
                ? `${(stats.data.totals.bytes / (1024 * 1024)).toFixed(1)} MB · ${stats.data.byLanguage[0]?.language ?? '—'} dominant`
                : 'counting files…'
            }
          />
        </div>
      </div>

      <section className="section">
        <h2 className="section__title">Key metrics</h2>
        <div className="grid grid--3">
          <Card title="Readiness">
            <ProgressBar
              value={o.readiness.score}
              kind={o.readiness.score >= 70 ? 'success' : o.readiness.score >= 40 ? 'warning' : 'danger'}
            />
            <div className="card__hint">{o.readiness.verdict}</div>
          </Card>
          <Card title="Drift / boundaries">
            <div className="metric-row">
              <span className="metric-row__value">{(quality.data?.blockers.length ?? 0) + (quality.data?.warnings.length ?? 0)}</span>
              <span className="metric-row__unit">findings</span>
            </div>
            <div className="card__hint">{quality.data?.blockers.length ?? 0} blockers</div>
          </Card>
          <Card title="Packs signed">
            <div className="metric-row">
              <span className="metric-row__value">{packs.data?.packs.filter((p) => p.signed).length ?? 0}</span>
              <span className="metric-row__unit">/ {packs.data?.packs.length ?? 0}</span>
            </div>
            <div className="card__hint">{unsignedPacks.length} unsigned</div>
          </Card>
        </div>
      </section>

      <section className="section">
        <h2 className="section__title">What needs attention</h2>
        <Card>
          {(() => {
            const items: { kind: 'success' | 'warning' | 'danger'; text: string }[] = [];
            for (const b of quality.data?.blockers ?? []) items.push({ kind: 'danger', text: `Quality blocker: ${b}` });
            for (const w of quality.data?.warnings ?? []) items.push({ kind: 'warning', text: `Quality warning: ${w}` });
            if (adoption.data?.state && adoption.data.state.freshness.status === 'stale')
              items.push({ kind: 'warning', text: 'Adoption patch is stale — run shrk onboard adopt regenerate' });
            for (const p of unsignedPacks) items.push({ kind: 'warning', text: `Unsigned pack: ${p.name}` });
            if (!items.length) {
              return <div className="card__hint">No outstanding issues — repo is healthy.</div>;
            }
            return (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {items.slice(0, 12).map((it, i) => (
                  <li key={i} style={{ padding: '6px 0', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                    <span className={`badge badge--${it.kind}`}>{it.kind}</span>
                    <span style={{ flex: 1 }}>{it.text}</span>
                  </li>
                ))}
              </ul>
            );
          })()}
        </Card>
      </section>

      <section className="section">
        <h2 className="section__title">Next recommended commands</h2>
        <div className="grid grid--2">
          <CommandBlock command="shrk quality --strict" purpose="Re-run quality gates strictly" safety="read-only" />
          <CommandBlock command="shrk safety audit --json" purpose="Audit the SharkCraft safety model" safety="read-only" />
          <CommandBlock command="shrk onboard adopt status" purpose="Inspect adoption patch freshness" safety="read-only" />
          <CommandBlock command="shrk dev start &quot;describe a task&quot;" purpose="Begin an AI-safe dev session" safety="writes-drafts" />
        </div>
      </section>

      <section className="section">
        <h2 className="section__title">Recent sessions</h2>
        {recentSessions.length === 0 ? (
          <EmptyState
            title="No sessions yet"
            description="Sessions track AI-safe workflow state under .sharkcraft/sessions/."
            command={'shrk dev start "describe a task"'}
            commandPurpose="Start the first session"
          />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Task</th>
                <th>Phase</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              {recentSessions.map((s) => (
                <tr key={s.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`#/sessions/${s.id}`)}>
                  <td className="mono" style={{ fontSize: 11.5 }}>{s.id}</td>
                  <td>{s.task ?? '—'}</td>
                  <td>{s.status ? <Badge kind="info">{s.status}</Badge> : '—'}</td>
                  <td className="mono" style={{ fontSize: 11.5 }}>{s.startedAt ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="section">
        <h2 className="section__title">Adoption state</h2>
        {!adoption.data?.available ? (
          <EmptyState
            title="No adoption patch yet"
            description="Generate one to migrate existing AGENTS.md/CLAUDE.md content into sharkcraft/."
            command="shrk onboard --write-drafts --scaffold-templates"
            commandPurpose="Step 1: write inferred drafts"
          />
        ) : (
          <Card>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <span className={fresh.className}>{fresh.label}</span>
              <span className="card__hint">format: {adoption.data.state?.diffFormat ?? 'unknown'}</span>
              <span className="card__hint">safe-to-adopt: {adoption.data.state?.categories.safeToAdopt ?? 0}</span>
              <span className="card__hint">manual review: {adoption.data.state?.categories.manualReview ?? 0}</span>
            </div>
          </Card>
        )}
      </section>

      <section className="section">
        <h2 className="section__title">System capabilities</h2>
        <div className="grid grid--3">
          <Card title="Read-only dashboard">
            This dashboard never writes. Every action is a copyable CLI command.
          </Card>
          <Card title="MCP read-only">
            MCP tools return data only. No write tools are exposed.
          </Card>
          <Card title="CLI is the write path">
            Source changes only happen through <code>shrk apply</code> with signature verification.
          </Card>
        </div>
      </section>
    </>
  );
}
