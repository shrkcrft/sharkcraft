import { useCallback } from 'react';
import { getReports } from '../api/endpoints.ts';
import { useApi } from '../api/useApi.ts';
import { PageHeader } from '../components/layout/PageHeader.tsx';
import { LoadingState } from '../components/primitives/LoadingState.tsx';
import { ErrorState } from '../components/primitives/ErrorState.tsx';
import { Card } from '../components/primitives/Card.tsx';
import { Badge } from '../components/primitives/Badge.tsx';
import { CommandBlock } from '../components/primitives/CommandBlock.tsx';

export function ReportsPage(): JSX.Element {
  const fetcher = useCallback((s: AbortSignal | undefined) => getReports(s), []);
  const r = useApi(fetcher);

  if (r.loading && !r.data) return <LoadingState />;
  if (r.error) return <ErrorState error={r.error} onRetry={r.refetch} />;
  const d = r.data!;

  return (
    <>
      <PageHeader title="Reports" subtitle="Renderable artifacts: text / markdown / html / json." />
      <div className="grid grid--2">
        {d.reports.map((rep) => (
          <Card key={rep.id} title={rep.title}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {rep.availableFormats.map((f) => <Badge key={f}>{f}</Badge>)}
            </div>
            <CommandBlock command={rep.commandHint} purpose={`Render the ${rep.title.toLowerCase()}`} safety="writes-drafts" />
            {rep.artifacts.length > 0 ? (
              <div className="card__hint">
                {rep.artifacts.map((a) => a.path).join('\n')}
              </div>
            ) : null}
          </Card>
        ))}
      </div>
    </>
  );
}
