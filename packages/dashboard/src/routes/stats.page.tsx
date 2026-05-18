import { useCallback } from 'react';
import { getStats } from '../api/endpoints.ts';
import { useApi } from '../api/useApi.ts';
import { PageHeader } from '../components/layout/PageHeader.tsx';
import { LoadingState } from '../components/primitives/LoadingState.tsx';
import { ErrorState } from '../components/primitives/ErrorState.tsx';
import { Card } from '../components/primitives/Card.tsx';
import { Badge } from '../components/primitives/Badge.tsx';
import { CommandBlock } from '../components/primitives/CommandBlock.tsx';

const KB = 1024;
const MB = KB * 1024;

function humanBytes(bytes: number): string {
  if (bytes >= MB) return (bytes / MB).toFixed(2) + ' MB';
  if (bytes >= KB) return (bytes / KB).toFixed(1) + ' KB';
  return bytes + ' B';
}

function compact(n: number): string {
  return n.toLocaleString();
}

export function StatsPage(): JSX.Element {
  const fetcher = useCallback((s: AbortSignal | undefined) => getStats(s, { top: 25 }), []);
  const stats = useApi(fetcher);

  if (stats.loading && !stats.data) return <LoadingState label="Counting files…" />;
  if (stats.error) return <ErrorState error={stats.error} onRetry={stats.refetch} />;
  const d = stats.data!;

  const dominant = d.byLanguage[0];
  const codeRatio =
    d.totals.totalLines > 0 ? Math.round((d.totals.codeLines / d.totals.totalLines) * 100) : 0;
  const commentRatio =
    d.totals.totalLines > 0 ? Math.round((d.totals.commentLines / d.totals.totalLines) * 100) : 0;

  return (
    <>
      <PageHeader
        title="Repository statistics"
        subtitle="Files, lines of code, sizes, and dominant languages — deterministic snapshot."
      />

      {d.truncated ? (
        <Card>
          <div className="card__hint">
            File walk truncated by the safety cap — totals are partial. Re-run with a higher
            <code className="mono"> maxFiles</code> via the CLI if needed.
          </div>
        </Card>
      ) : null}

      <div className="grid grid--4">
        <Card title="Total files" big={compact(d.totals.files)} hint={`${d.byLanguage.length} languages detected`} />
        <Card
          title="Total size"
          big={humanBytes(d.totals.bytes)}
          hint={`${compact(d.totals.bytes)} bytes`}
        />
        <Card
          title="Lines of code"
          big={compact(d.totals.codeLines)}
          hint={`${codeRatio}% of ${compact(d.totals.totalLines)} total · ${commentRatio}% comments`}
        />
        <Card
          title="Dominant language"
          big={dominant?.language ?? '—'}
          hint={dominant ? `${compact(dominant.files)} files · ${humanBytes(dominant.bytes)}` : 'no source files found'}
        />
      </div>

      <section className="section">
        <h2 className="section__title">Per-language breakdown</h2>
        <table className="table">
          <thead>
            <tr>
              <th>Language</th>
              <th style={{ textAlign: 'right' }}>Files</th>
              <th style={{ textAlign: 'right' }}>Code</th>
              <th style={{ textAlign: 'right' }}>Comment</th>
              <th style={{ textAlign: 'right' }}>Blank</th>
              <th style={{ textAlign: 'right' }}>Size</th>
              <th style={{ textAlign: 'right' }}>Avg lines/file</th>
              <th>Extensions</th>
            </tr>
          </thead>
          <tbody>
            {d.byLanguage.map((l) => (
              <tr key={l.language}>
                <td className="mono">
                  <Badge>{l.language}</Badge>
                </td>
                <td style={{ textAlign: 'right' }} className="mono">{compact(l.files)}</td>
                <td style={{ textAlign: 'right' }} className="mono">{compact(l.codeLines)}</td>
                <td style={{ textAlign: 'right' }} className="mono">{compact(l.commentLines)}</td>
                <td style={{ textAlign: 'right' }} className="mono">{compact(l.blankLines)}</td>
                <td style={{ textAlign: 'right' }} className="mono">{humanBytes(l.bytes)}</td>
                <td style={{ textAlign: 'right' }} className="mono">{compact(l.averageFileLines)}</td>
                <td className="mono" style={{ fontSize: 11.5 }}>
                  {l.extensions.join(' ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="section">
        <h2 className="section__title">Largest files</h2>
        {d.topFiles.length === 0 ? (
          <Card>
            <div className="card__hint">No files matched.</div>
          </Card>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th style={{ textAlign: 'right' }}>Size</th>
                <th style={{ textAlign: 'right' }}>Lines</th>
                <th>Language</th>
                <th>Path</th>
              </tr>
            </thead>
            <tbody>
              {d.topFiles.map((f) => (
                <tr key={f.path}>
                  <td style={{ textAlign: 'right' }} className="mono">{humanBytes(f.bytes)}</td>
                  <td style={{ textAlign: 'right' }} className="mono">{compact(f.lines)}</td>
                  <td className="mono">{f.language}</td>
                  <td className="mono" style={{ fontSize: 11.5 }}>{f.path}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="section">
        <h2 className="section__title">Excluded directories</h2>
        <Card>
          <div className="card__hint mono" style={{ fontSize: 11.5 }}>
            {d.ignoredDirectories.join(' · ')}
          </div>
        </Card>
      </section>

      <section className="section">
        <h2 className="section__title">Commands</h2>
        <div className="grid grid--2">
          <CommandBlock command="shrk stats" purpose="Print stats to terminal" safety="read-only" />
          <CommandBlock command="shrk stats --json" purpose="Emit machine-readable stats" safety="read-only" />
          <CommandBlock
            command="shrk stats --language typescript"
            purpose="Filter to a single language"
            safety="read-only"
          />
          <CommandBlock command="shrk stats --top 25" purpose="Surface more large files" safety="read-only" />
        </div>
      </section>
    </>
  );
}
