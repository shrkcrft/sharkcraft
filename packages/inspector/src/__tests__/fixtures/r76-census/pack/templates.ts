export default [
  // No `tags` / `scope` / `appliesWhen`: the loader normalises them to [] (12.1d).
  { id: 'cz.t-ok', name: 'T ok', description: 'Census template.', variables: [], targetPath: () => 'src/cz.ts', content: () => 'export {};' },
  { id: 'cz.t-bad', description: 'no name' },
];
