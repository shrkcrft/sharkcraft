import type { DashboardApiError } from '../../api/client.ts';

export interface IErrorStateProps {
  error: DashboardApiError | Error | null;
  onRetry?: () => void;
}

export function ErrorState({ error, onRetry }: IErrorStateProps): JSX.Element {
  return (
    <div className="error">
      <div className="empty__title" style={{ color: 'var(--danger)' }}>
        Failed to load
      </div>
      <div style={{ marginTop: 6, fontFamily: 'var(--mono)' }}>
        {error?.message ?? 'unknown error'}
      </div>
      {onRetry ? (
        <button className="btn" style={{ marginTop: 12 }} onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}
