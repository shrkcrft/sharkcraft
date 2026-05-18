export interface IProgressBarProps {
  value: number;
  max?: number;
  kind?: 'success' | 'warning' | 'danger' | 'default';
}

export function ProgressBar({ value, max = 100, kind = 'default' }: IProgressBarProps): JSX.Element {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const cls = kind === 'default' ? 'progress__bar' : `progress__bar progress__bar--${kind}`;
  return (
    <div className="progress">
      <div className={cls} style={{ width: `${pct}%` }} />
    </div>
  );
}
