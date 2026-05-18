import { useCallback } from 'react';
import { getAdoption, getOnboarding } from '../api/endpoints.ts';
import { usePollingApi } from '../api/useApi.ts';
import { PageHeader } from '../components/layout/PageHeader.tsx';
import { LoadingState } from '../components/primitives/LoadingState.tsx';
import { ErrorState } from '../components/primitives/ErrorState.tsx';
import { Card } from '../components/primitives/Card.tsx';
import { MetricCard } from '../components/primitives/MetricCard.tsx';
import { EmptyState } from '../components/primitives/EmptyState.tsx';
import { CommandBlock } from '../components/primitives/CommandBlock.tsx';
import { freshnessBadge } from '../utils/status.ts';

export function OnboardingPage(): JSX.Element {
  const o = useCallback((s: AbortSignal | undefined) => getOnboarding(s), []);
  const a = useCallback((s: AbortSignal | undefined) => getAdoption(s), []);
  const onboarding = usePollingApi(o, 15000, true);
  const adoption = usePollingApi(a, 10000, true);

  if (onboarding.loading && !onboarding.data) return <LoadingState />;
  if (onboarding.error) return <ErrorState error={onboarding.error} onRetry={onboarding.refetch} />;
  const od = onboarding.data!;
  const ad = adoption.data;
  const fresh = freshnessBadge(ad?.state?.freshness.status);

  return (
    <>
      <PageHeader title="Onboarding & adoption" subtitle="Migrate existing AGENTS.md/CLAUDE.md content into sharkcraft/." />

      <div className="grid grid--4">
        <MetricCard label="Inferred rules" value={od.summary?.inferredRules ?? 0} />
        <MetricCard label="Inferred paths" value={od.summary?.inferredPaths ?? 0} />
        <MetricCard label="Inferred templates" value={od.summary?.inferredTemplates ?? 0} />
        <MetricCard label="Imported agents" value={od.summary?.importedAgents ?? 0} />
      </div>

      <section className="section">
        <h2 className="section__title">Adoption state</h2>
        {!ad?.available ? (
          <EmptyState
            title="No adoption state yet"
            description="Generate one in two steps."
            command="shrk onboard --write-drafts --scaffold-templates"
            commandPurpose="Step 1: write inferred drafts"
            hint={'Then: shrk onboard adopt --write-patch --diff-format unified'}
          />
        ) : (
          <Card>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <span className={fresh.className}>{fresh.label}</span>
              <span className="card__hint">format: {ad.state?.diffFormat ?? '—'}</span>
              <span className="card__hint">patch: <code>{ad.state?.patchPath ?? '—'}</code></span>
            </div>
            <hr className="section-divider" />
            <div className="grid grid--3">
              <div>
                <div className="card__title">Categories</div>
                <div>safe-to-adopt: {ad.state?.categories.safeToAdopt ?? 0}</div>
                <div>manual review: {ad.state?.categories.manualReview ?? 0}</div>
                <div>low confidence: {ad.state?.categories.lowConfidence ?? 0}</div>
                <div>conflicts: {ad.state?.categories.conflicts ?? 0}</div>
                <div>already covered: {ad.state?.categories.alreadyCovered ?? 0}</div>
                <div>skipped: {ad.state?.categories.skipped ?? 0}</div>
              </div>
              <div>
                <div className="card__title">Stale reasons</div>
                {(ad.state?.freshness.staleReasons ?? []).length === 0 ? (
                  <div className="card__hint">none</div>
                ) : (
                  <ul style={{ margin: 0, paddingLeft: 16 }}>
                    {ad.state!.freshness.staleReasons.slice(0, 6).map((r, i) => <li key={i}>{r}</li>)}
                  </ul>
                )}
              </div>
              <div>
                <div className="card__title">Changes since patch</div>
                <div>changed targets: {ad.state?.freshness.changedTargets.length ?? 0}</div>
                <div>changed drafts: {ad.state?.freshness.changedDrafts.length ?? 0}</div>
                <div>missing targets: {ad.state?.freshness.missingTargets.length ?? 0}</div>
              </div>
            </div>
          </Card>
        )}
      </section>

      <section className="section">
        <h2 className="section__title">Next commands</h2>
        <div className="grid grid--2">
          {(ad?.nextCommands ?? []).map((c, i) => (
            <CommandBlock key={i} command={c.command} purpose={c.purpose} safety={c.safety} />
          ))}
          <CommandBlock command="shrk onboard adopt report --format html" purpose="Save adoption HTML report" safety="writes-drafts" />
        </div>
      </section>
    </>
  );
}
