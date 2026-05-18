export function JsonView({ value }: { value: unknown }): JSX.Element {
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
}
