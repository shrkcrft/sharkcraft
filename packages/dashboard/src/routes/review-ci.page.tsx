import { useCallback } from 'react';
import { getReview } from '../api/endpoints.ts';
import { useApi } from '../api/useApi.ts';
import { PageHeader } from '../components/layout/PageHeader.tsx';
import { LoadingState } from '../components/primitives/LoadingState.tsx';
import { ErrorState } from '../components/primitives/ErrorState.tsx';
import { Card } from '../components/primitives/Card.tsx';
import { CommandBlock } from '../components/primitives/CommandBlock.tsx';
import { EmptyState } from '../components/primitives/EmptyState.tsx';

export function ReviewCiPage(): JSX.Element {
  const fetcher = useCallback((s: AbortSignal | undefined) => getReview(s), []);
  const r = useApi(fetcher);

  if (r.loading && !r.data) return <LoadingState />;
  if (r.error) return <ErrorState error={r.error} onRetry={r.refetch} />;
  const d = r.data!;

  return (
    <>
      <PageHeader title="Review & CI" subtitle="PR review packets, rendered comments, CI scaffolds." />
      {!d.available ? (
        <EmptyState
          title="No review packet provided"
          description="Generate one for the current branch, then re-open the dashboard with ?packet=<path>."
          command="shrk review --since origin/main --json --output review.json"
          commandPurpose="Generate a review packet from a git diff"
        />
      ) : (
        <>
          <Card title="Review packet">
            <div className="mono" style={{ fontSize: 12 }}>{d.packetPath}</div>
            {d.summary ? <div className="card__hint">{d.summary}</div> : null}
          </Card>
          <section className="section">
            <h2 className="section__title">Affected / rules / checks</h2>
            <div className="grid grid--3">
              <Card title="Affected areas">{d.affectedAreas.join(', ') || '—'}</Card>
              <Card title="Relevant rules">{d.relevantRules.join(', ') || '—'}</Card>
              <Card title="Suggested checks">{d.suggestedChecks.join(', ') || '—'}</Card>
            </div>
          </section>
        </>
      )}

      <section className="section">
        <h2 className="section__title">CI integration</h2>
        <div className="grid grid--2">
          <CommandBlock command="shrk review --since origin/main --json" purpose="Build a review packet for CI" safety="read-only" />
          <CommandBlock command="shrk review render-comment <packet.json> --format github" purpose="Render a PR comment" safety="read-only" />
          <CommandBlock command="shrk ci scaffold github-actions --with-quality --with-review" purpose="Scaffold a GitHub Actions workflow" safety="writes-drafts" />
          <CommandBlock command="shrk report quality --format html --output ./quality.html" purpose="Attach quality HTML as artifact" safety="writes-drafts" />
        </div>
      </section>
    </>
  );
}
