import { useEffect, useState } from 'react';
import { getHealth } from '../../api/endpoints.ts';
import { Badge } from '../primitives/Badge.tsx';
import { StatusDot } from '../primitives/StatusDot.tsx';
import { formatRelative } from '../../utils/format.ts';

export interface ITopbarProps {
  projectRoot: string | null;
  onRefresh?: () => void;
  lastUpdated?: string | null;
  autoRefresh?: boolean;
  onToggleAutoRefresh?: () => void;
}

export function Topbar({
  projectRoot,
  onRefresh,
  lastUpdated,
  autoRefresh,
  onToggleAutoRefresh,
}: ITopbarProps): JSX.Element {
  const [healthOk, setHealthOk] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    const probe = (): void => {
      getHealth()
        .then((r) => {
          if (!cancelled) setHealthOk(r.data.ok === true);
        })
        .catch(() => {
          if (!cancelled) setHealthOk(false);
        });
    };
    probe();
    const t = setInterval(probe, 15000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  return (
    <header className="topbar" data-testid="topbar">
      <div className="topbar__left">
        <StatusDot kind={healthOk === true ? 'success' : healthOk === false ? 'danger' : 'default'} />
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>API</span>
        <span className="topbar__project-root" title={projectRoot ?? ''}>
          {projectRoot ?? '—'}
        </span>
      </div>
      <div className="topbar__right">
        <Badge kind="success">read-only</Badge>
        {lastUpdated ? (
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>
            updated {formatRelative(lastUpdated)}
          </span>
        ) : null}
        {onToggleAutoRefresh ? (
          <button
            className={`btn btn--ghost`}
            onClick={onToggleAutoRefresh}
            type="button"
            aria-pressed={autoRefresh ?? false}
          >
            {autoRefresh ? 'Auto-refresh on' : 'Auto-refresh off'}
          </button>
        ) : null}
        {onRefresh ? (
          <button className="btn" onClick={onRefresh} type="button">
            Refresh
          </button>
        ) : null}
      </div>
    </header>
  );
}
