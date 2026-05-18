export type StatusKind = 'default' | 'success' | 'warning' | 'danger';

export function StatusDot({ kind = 'default' }: { kind?: StatusKind }): JSX.Element {
  const cls = kind === 'default' ? 'dot' : `dot dot--${kind}`;
  return <span className={cls} aria-hidden />;
}
