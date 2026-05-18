export const exampleRule = {
  id: 'pack.example.preferred-style',
  title: 'Prefer named exports in shared modules',
  type: 'rule',
  priority: 'medium',
  scope: ['typescript'],
  tags: ['style'],
  appliesWhen: ['generate-code'],
  content: `When a module is consumed by more than one place, prefer named
exports over default exports. This makes refactors safer and makes imports
discoverable via grep.`,
};

export default [exampleRule];
