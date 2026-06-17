import { useCallback } from 'react';
import { getCompression } from '../api/endpoints.ts';
import { useApi } from '../api/useApi.ts';
import { PageHeader } from '../components/layout/PageHeader.tsx';
import { LoadingState } from '../components/primitives/LoadingState.tsx';
import { ErrorState } from '../components/primitives/ErrorState.tsx';
import { Card } from '../components/primitives/Card.tsx';
import { Badge } from '../components/primitives/Badge.tsx';
import { CommandBlock } from '../components/primitives/CommandBlock.tsx';

function compact(n: number): string {
  return n.toLocaleString();
}

export function CompressionPage(): JSX.Element {
  const fetcher = useCallback((s: AbortSignal | undefined) => getCompression(s), []);
  const compression = useApi(fetcher);

  if (compression.loading && !compression.data) return <LoadingState label="Measuring token savings…" />;
  if (compression.error) return <ErrorState error={compression.error} onRetry={compression.refetch} />;
  const d = compression.data!;

  const saved = d.totals.before - d.totals.after;
  // The estimator is sound on percentages but rough on absolute counts, so be
  // explicit about which kind of number is on screen. The reduction % is the
  // trustworthy figure either way.
  const tokenUnit = d.tokensAreEstimated ? '≈ estimated tokens' : 'exact tokens (cl100k_base)';

  return (
    <>
      <PageHeader
        title="Token savings"
        subtitle={`What the deterministic compression layer saves on each MCP surface — measured on this workspace (${tokenUnit}).`}
      />

      <div className="grid grid--4">
        <Card title="Tokens before" big={compact(d.totals.before)} hint={`raw JSON encoding · ${tokenUnit}`} />
        <Card title="Tokens after" big={compact(d.totals.after)} hint={`compressed encoding · ${tokenUnit}`} />
        <Card title="Tokens saved" big={compact(saved)} hint={`${d.surfaces.length} surfaces · ${tokenUnit}`} />
        <Card
          title="Reduction"
          big={`${d.totals.savedPct}%`}
          hint={d.totals.savedPct > 0 ? 'fewer tokens per fetch' : 'no measurable gain'}
        />
      </div>

      <section className="section">
        <h2 className="section__title">Per-surface savings</h2>
        {d.surfaces.length === 0 ? (
          <Card>
            <div className="card__hint">No surfaces measured for this workspace yet.</div>
          </Card>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Surface</th>
                <th>Strategy</th>
                <th style={{ textAlign: 'right' }}>Before</th>
                <th style={{ textAlign: 'right' }}>After</th>
                <th style={{ textAlign: 'right' }}>Saved</th>
              </tr>
            </thead>
            <tbody>
              {d.surfaces.map((s) => (
                <tr key={s.surface}>
                  <td className="mono">{s.surface}</td>
                  <td className="mono">
                    <Badge>{s.strategy}</Badge>
                  </td>
                  <td style={{ textAlign: 'right' }} className="mono">{compact(s.before)}</td>
                  <td style={{ textAlign: 'right' }} className="mono">{compact(s.after)}</td>
                  <td style={{ textAlign: 'right' }} className="mono">{s.savedPct}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="section">
        <h2 className="section__title">How it works</h2>
        <Card>
          <div className="card__hint">
            MCP tools accept <code className="mono">format:"table"</code> to return structured lists as a
            columnar encoding instead of a JSON array of objects — field names are written once, not per row.
            Lossy text surfaces (logs, diffs, search) go through reversible compressors with a net-loss guard,
            so the agent never pays more tokens than the raw payload would cost.
          </div>
        </Card>
      </section>

      <section className="section">
        <h2 className="section__title">Commands</h2>
        <div className="grid grid--2">
          <CommandBlock
            command="shrk compress <file>"
            purpose="Compress a file and report token savings"
            safety="read-only"
          />
          <CommandBlock
            command="SHRK_MCP_TABLE=1 bun run mcp"
            purpose="Default MCP surfaces to columnar table encoding"
            safety="read-only"
          />
        </div>
      </section>
    </>
  );
}
