import { useCallback } from 'react';
import { getCommands, getMcp, getSafety } from '../api/endpoints.ts';
import { usePollingApi } from '../api/useApi.ts';
import { PageHeader } from '../components/layout/PageHeader.tsx';
import { LoadingState } from '../components/primitives/LoadingState.tsx';
import { ErrorState } from '../components/primitives/ErrorState.tsx';
import { Card } from '../components/primitives/Card.tsx';
import { MetricCard } from '../components/primitives/MetricCard.tsx';
import { CommandBlock } from '../components/primitives/CommandBlock.tsx';
import { safetyToBadge } from '../utils/status.ts';

export function SafetyPage(): JSX.Element {
  const s = useCallback((sg: AbortSignal | undefined) => getSafety(sg), []);
  const c = useCallback((sg: AbortSignal | undefined) => getCommands(sg), []);
  const m = useCallback((sg: AbortSignal | undefined) => getMcp(sg), []);
  const safety = usePollingApi(s, 60000, true);
  const commands = usePollingApi(c, 60000, true);
  const mcp = usePollingApi(m, 60000, true);

  if (safety.loading && !safety.data) return <LoadingState />;
  if (safety.error) return <ErrorState error={safety.error} onRetry={safety.refetch} />;
  const sd = safety.data!;

  const byLevel: Record<string, number> = {};
  for (const c of commands.data?.commands ?? []) byLevel[c.safety.level] = (byLevel[c.safety.level] ?? 0) + 1;

  return (
    <>
      <PageHeader
        title="Safety"
        subtitle="Auditable model: MCP read-only, write paths, shell runners, signing."
      />

      <section className="section">
        <h2 className="section__title">MCP write invariant</h2>
        <Card>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 28, fontWeight: 700 }}>
            <span className={`badge ${sd.mcpReadOnly ? 'badge--success' : 'badge--danger'}`} style={{ fontSize: 16, padding: '4px 12px' }}>
              {sd.mcpReadOnly ? 'PASS' : 'FAIL'}
            </span>
            <span>{sd.mcpReadOnly ? 'MCP is read-only' : 'MCP exposes writes!'}</span>
          </div>
          <div className="card__hint">
            {mcp.data?.tools.length ?? 0} tool(s) registered. All return data only.
          </div>
        </Card>
      </section>

      <section className="section">
        <h2 className="section__title">CLI safety levels</h2>
        <div className="grid grid--4">
          {(['read-only', 'writes-drafts', 'writes-source', 'runs-shell'] as const).map((lvl) => {
            const b = safetyToBadge(lvl);
            return (
              <MetricCard key={lvl} label={<span className={b.className}>{b.label}</span>} value={byLevel[lvl] ?? 0} hint="commands" />
            );
          })}
        </div>
      </section>

      <section className="section">
        <h2 className="section__title">Write-capable commands</h2>
        {sd.writeCapableCommands.length === 0 ? (
          <Card><div className="card__hint">None.</div></Card>
        ) : (
          <Card>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {sd.writeCapableCommands.map((c) => (
                <code key={c} className="kbd">{c}</code>
              ))}
            </div>
          </Card>
        )}
      </section>

      <section className="section">
        <h2 className="section__title">Shell-running commands</h2>
        {sd.shellRunningCommands.length === 0 ? (
          <Card><div className="card__hint">None.</div></Card>
        ) : (
          <Card>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {sd.shellRunningCommands.map((c) => (
                <code key={c} className="kbd">{c}</code>
              ))}
            </div>
          </Card>
        )}
      </section>

      <section className="section">
        <h2 className="section__title">Pack & plan signing</h2>
        <div className="grid grid--2">
          <Card title="Pack signatures">
            <div className="metric-row">
              <span className="metric-row__value">{sd.packSigning.verified}</span>
              <span className="metric-row__unit">verified</span>
            </div>
            <div className="card__hint">{sd.packSigning.unsigned} unsigned · required: {sd.packSigning.required ? 'yes' : 'no'}</div>
          </Card>
          <Card title="Plan signing">
            <div className="card__hint">
              verifySignatureSupported: {String(sd.planSigning.verifySignatureSupported)}
              <br />
              hmacBased: {String(sd.planSigning.hmacBased)}
            </div>
          </Card>
        </div>
      </section>

      <section className="section">
        <h2 className="section__title">Recommendations</h2>
        {sd.recommendations.length === 0 ? (
          <Card><div className="card__hint">No recommendations.</div></Card>
        ) : (
          <Card>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {sd.recommendations.map((r, i) => <li key={i}>{r}</li>)}
            </ul>
          </Card>
        )}
      </section>

      <section className="section">
        <h2 className="section__title">Audit commands</h2>
        <div className="grid grid--2">
          <CommandBlock command="shrk safety audit --json" purpose="Full safety audit as JSON" safety="read-only" />
          <CommandBlock command="shrk commands doctor" purpose="Check command catalog invariants" safety="read-only" />
          <CommandBlock command="shrk commands --safety read-only" purpose="List read-only commands" safety="read-only" />
          <CommandBlock command="shrk report safety --format html --output ./safety.html" purpose="Save safety audit HTML" safety="writes-drafts" />
        </div>
      </section>
    </>
  );
}
