import { useCallback } from 'react';
import { getPipelines, getPresets } from '../api/endpoints.ts';
import { useApi } from '../api/useApi.ts';
import { PageHeader } from '../components/layout/PageHeader.tsx';
import { LoadingState } from '../components/primitives/LoadingState.tsx';
import { ErrorState } from '../components/primitives/ErrorState.tsx';
import { Card } from '../components/primitives/Card.tsx';
import { EmptyState } from '../components/primitives/EmptyState.tsx';
import { CommandBlock } from '../components/primitives/CommandBlock.tsx';

export function PresetsPipelinesPage(): JSX.Element {
  const p = useCallback((s: AbortSignal | undefined) => getPresets(s), []);
  const pi = useCallback((s: AbortSignal | undefined) => getPipelines(s), []);
  const presets = useApi(p);
  const pipelines = useApi(pi);

  if ((presets.loading && !presets.data) || (pipelines.loading && !pipelines.data)) return <LoadingState />;
  if (presets.error) return <ErrorState error={presets.error} onRetry={presets.refetch} />;
  if (pipelines.error) return <ErrorState error={pipelines.error} onRetry={pipelines.refetch} />;

  return (
    <>
      <PageHeader title="Presets & pipelines" subtitle="Reusable workflows that compose templates + rules + paths." />

      <section className="section">
        <h2 className="section__title">Presets</h2>
        {(presets.data?.presets ?? []).length === 0 ? (
          <EmptyState
            title="No presets"
            description="Presets are bundles you can apply to a workspace via shrk presets get."
            command="shrk presets recommend"
            commandPurpose="See suggested presets"
          />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Title</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {presets.data!.presets.map((p) => (
                <tr key={p.id}>
                  <td className="mono">{p.id}</td>
                  <td>{p.title}</td>
                  <td className="mono" style={{ fontSize: 11.5 }}>{p.source ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="section">
        <h2 className="section__title">Pipelines</h2>
        {(pipelines.data?.pipelines ?? []).length === 0 ? (
          <Card><div className="card__hint">No pipelines registered. Add via <code>definePipeline()</code> in sharkcraft/pipelines.ts.</div></Card>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Title</th>
                <th>Steps</th>
              </tr>
            </thead>
            <tbody>
              {pipelines.data!.pipelines.map((p) => (
                <tr key={p.id}>
                  <td className="mono">{p.id}</td>
                  <td>{p.title}</td>
                  <td>{p.steps}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="section">
        <h2 className="section__title">Commands</h2>
        <div className="grid grid--2">
          <CommandBlock command="shrk presets recommend" purpose="Best-fit presets for this repo" safety="read-only" />
          <CommandBlock command="shrk presets get <id>" purpose="Inspect a preset" safety="read-only" />
          <CommandBlock command="shrk pipelines get <id>" purpose="Inspect a pipeline" safety="read-only" />
          <CommandBlock command={'shrk pipelines script <id> --task "..."'} purpose="Render a pipeline script" safety="read-only" />
        </div>
      </section>
    </>
  );
}
