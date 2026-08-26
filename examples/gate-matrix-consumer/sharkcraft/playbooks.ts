/**
 * A playbook the doc-reference rule must resolve.
 *
 * The corpus asserts a PLAYBOOK id resolves, not just a template one: the two
 * kinds read different registries, and the playbook one shipped resolving
 * nothing at all while the template one worked — so a fixture covering only
 * templates was green through the whole bug.
 */
export default [
  {
    id: 'gmc.add-handler',
    title: 'Add a handler',
    description: 'The end-to-end flow for adding a handler to this consumer.',
    steps: [{ id: 'scaffold', title: 'Scaffold the handler', kind: 'generate' }],
  },
];
