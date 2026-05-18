import { useCallback } from 'react';
import { getPacks, getScaffolds } from '../api/endpoints.ts';
import { useApi } from '../api/useApi.ts';
import { PageHeader } from '../components/layout/PageHeader.tsx';
import { LoadingState } from '../components/primitives/LoadingState.tsx';
import { ErrorState } from '../components/primitives/ErrorState.tsx';
import { Card } from '../components/primitives/Card.tsx';
import { Badge } from '../components/primitives/Badge.tsx';
import { CommandBlock } from '../components/primitives/CommandBlock.tsx';
import { EmptyState } from '../components/primitives/EmptyState.tsx';

export function PacksPage(): JSX.Element {
  const p = useCallback((s: AbortSignal | undefined) => getPacks(s), []);
  const sc = useCallback((s: AbortSignal | undefined) => getScaffolds(s), []);
  const packs = useApi(p);
  const scaffolds = useApi(sc);

  if (packs.loading && !packs.data) return <LoadingState />;
  if (packs.error) return <ErrorState error={packs.error} onRetry={packs.refetch} />;
  const pd = packs.data!;

  if (!pd.available) {
    return (
      <>
        <PageHeader title="Packs" />
        <EmptyState
          title="No packs discovered"
          description="Packs are installed npm packages that contribute knowledge/rules/paths/templates/pipelines/scaffold patterns."
          command="shrk packs list --json"
          commandPurpose="Inspect pack discovery"
        />
      </>
    );
  }

  const signed = pd.packs.filter((p) => p.signed).length;
  const unsigned = pd.packs.length - signed;

  return (
    <>
      <PageHeader title="Packs" subtitle="Ecosystem health: discovery, signing, resolution." />
      <div className="grid grid--3">
        <Card title="Discovered" big={pd.packs.length} />
        <Card title="Signed" big={signed} hint={`${unsigned} unsigned`} />
        <Card title="Scaffold patterns" big={scaffolds.data?.patterns.length ?? 0} />
      </div>

      <section className="section">
        <h2 className="section__title">Packs</h2>
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Version</th>
              <th>Signed</th>
              <th>Resolved</th>
              <th>Warnings</th>
            </tr>
          </thead>
          <tbody>
            {pd.packs.map((p) => {
              const counts = p.resolvedCounts ?? {};
              return (
                <tr key={p.id}>
                  <td className="mono">{p.name}</td>
                  <td className="mono">{p.version ?? '—'}</td>
                  <td>
                    <Badge kind={p.signed ? 'success' : 'warning'}>{p.signed ? 'signed' : 'unsigned'}</Badge>
                  </td>
                  <td className="mono" style={{ fontSize: 11.5 }}>
                    {Object.entries(counts)
                      .filter(([, v]) => (v as number) > 0)
                      .map(([k, v]) => `${k}=${v}`)
                      .join(' · ') || '—'}
                  </td>
                  <td className="card__hint" style={{ fontSize: 11.5 }}>
                    {(p.warnings ?? []).join('; ') || '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="section">
        <h2 className="section__title">Scaffold patterns</h2>
        {(scaffolds.data?.patterns ?? []).length === 0 ? (
          <Card><div className="card__hint">No scaffold patterns contributed by installed packs.</div></Card>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Template</th>
                <th>Confidence</th>
                <th>Source</th>
                <th>Paths</th>
              </tr>
            </thead>
            <tbody>
              {scaffolds.data!.patterns.map((p) => (
                <tr key={p.id}>
                  <td className="mono">{p.id}</td>
                  <td className="mono">{p.templateId}</td>
                  <td><Badge>{p.confidence}</Badge></td>
                  <td className="mono" style={{ fontSize: 11.5 }}>{p.source}</td>
                  <td className="mono" style={{ fontSize: 11.5 }}>{p.matchPaths.join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="section">
        <h2 className="section__title">Commands</h2>
        <div className="grid grid--2">
          <CommandBlock command="shrk packs list" purpose="List installed packs" safety="read-only" />
          <CommandBlock command="shrk packs doctor --require-signatures" purpose="Verify signatures" safety="read-only" />
          <CommandBlock command="shrk packs test <path> --load" purpose="Load pack assets and report" safety="read-only" />
          <CommandBlock command="shrk packs new <name>" purpose="Scaffold a new pack" safety="writes-drafts" />
        </div>
      </section>
    </>
  );
}
