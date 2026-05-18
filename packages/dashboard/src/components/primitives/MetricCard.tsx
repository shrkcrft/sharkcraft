import type { ReactNode } from 'react';

export interface IMetricCardProps {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  trend?: ReactNode;
  badge?: ReactNode;
}

export function MetricCard({ label, value, hint, trend, badge }: IMetricCardProps): JSX.Element {
  return (
    <div className="card">
      <div className="card__title">
        {label} {badge}
      </div>
      <div className="metric-row">
        <span className="metric-row__value">{value}</span>
        {trend ? <span className="metric-row__unit">{trend}</span> : null}
      </div>
      {hint ? <div className="card__hint">{hint}</div> : null}
    </div>
  );
}
