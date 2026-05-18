export function LoadingState({ label }: { label?: string }): JSX.Element {
  return <div className="loading">{label ?? 'Loading…'}</div>;
}
