# Context regression tests

Pin the SharkCraft retrieval behavior for your project. A test declares a
task and asserts that certain knowledge IDs *must* appear in the
token-budgeted context — or that other IDs *must not*.

```ts
// sharkcraft/context-tests.ts
import { defineContextTest } from '@shrkcrft/inspector';

export default [
  defineContextTest({
    id: 'plugin-task',
    task: 'create a user profile plugin',
    mustInclude: ['plugin.no-own-defaults', 'architecture.layer-order'],
    mustNotInclude: ['adapter.no-business-logic'],
    maxTokens: 3500,
  }),
];
```

Run the tests:

```bash
shrk test context              # all
shrk test context --id <id>    # one
shrk test context --json
```

MCP: `list_context_tests`, `run_context_test`. Packs contribute via
`contextTestFiles`.

Use cases:

- Catch retrieval regressions when you change knowledge or the ranker.
- Verify a new pack actually surfaces its rules for the expected tasks.
- Pin the behavior for paid/private packs before publishing.
