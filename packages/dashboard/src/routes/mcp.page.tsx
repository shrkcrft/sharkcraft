import { useCallback } from 'react';
import { getMcp } from '../api/endpoints.ts';
import { useApi } from '../api/useApi.ts';
import { PageHeader } from '../components/layout/PageHeader.tsx';
import { LoadingState } from '../components/primitives/LoadingState.tsx';
import { ErrorState } from '../components/primitives/ErrorState.tsx';
import { Card } from '../components/primitives/Card.tsx';
import { Badge } from '../components/primitives/Badge.tsx';
import { CommandBlock } from '../components/primitives/CommandBlock.tsx';

export function McpPage(): JSX.Element {
  const fetcher = useCallback((s: AbortSignal | undefined) => getMcp(s), []);
  const mcp = useApi(fetcher);

  if (mcp.loading && !mcp.data) return <LoadingState />;
  if (mcp.error) return <ErrorState error={mcp.error} onRetry={mcp.refetch} />;
  const d = mcp.data!;

  return (
    <>
      <PageHeader title="MCP" subtitle="Read-only MCP tools exposed to agents." />
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Badge kind="success">read-only</Badge>
          <span>{d.tools.length} tools · transports: {d.transports.join(', ')}</span>
        </div>
      </Card>

      <section className="section">
        <h2 className="section__title">Tools</h2>
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Description</th>
              <th>Writes</th>
            </tr>
          </thead>
          <tbody>
            {d.tools.map((t) => (
              <tr key={t.name}>
                <td className="mono">{t.name}</td>
                <td>{t.description ?? '—'}</td>
                <td><Badge kind="success">no</Badge></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="section">
        <h2 className="section__title">Setup</h2>
        <div className="grid grid--2">
          <CommandBlock command="shrk mcp serve" purpose="Start MCP server (stdio)" safety="read-only" />
          <CommandBlock command="shrk mcp serve --http --port 4000" purpose="Start MCP server over HTTP" safety="read-only" />
          <CommandBlock command="shrk mcp configure-claude-code" purpose="Wire up Claude Code config" safety="writes-drafts" />
        </div>
      </section>
    </>
  );
}
