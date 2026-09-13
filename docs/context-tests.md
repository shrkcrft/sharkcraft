# Context regression tests

Pin the SharkCraft retrieval behavior for your project. A test declares a
task and asserts that certain knowledge IDs *must* appear in the
token-budgeted context — or that other IDs *must not*.

```ts
// sharkcraft/context-tests.ts
import { defineContextTest } from '@shrkcrft/inspector';

export default [
  defineContextTest({
    id: 'service-task',
    task: 'create a new user profile service',
    mustInclude: ['repo.architecture.respect-boundaries'],
    mustNotInclude: ['some-rule-that-should-not-fire'],
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

Exit codes: `0` every selected test passed · `1` a test failed · `2` NOT
VERIFIED — no context tests are configured (`--allow-empty` accepts that
explicitly) · `3` an `--id` that selects nothing. `--json` always carries
`exitCode` and `verdict`.

MCP: `list_context_tests`, `run_context_test`. Packs contribute via
`contextTestFiles`.

## What the fields assert

`mustInclude` / `mustNotInclude` are **ranker-surfaced** assertions: the id is
(or is not) in the token-budgeted context body the ranker built for THIS task.
They are order-sensitive, so an unrelated knowledge edit can flip them.

Whether the id exists at all is a separate, stable question. A failing
`mustInclude` diagnostic answers it — `existsInRegistry`, resolved against the
shared reference registry (the set `shrk knowledge list` prints), with the
registry it `consulted` named — so "never registered" (the test can never pass)
reads differently from "registered, but not ranked for this task".

Use cases:

- Catch retrieval regressions when you change knowledge or the ranker.
- Verify a new pack actually surfaces its rules for the expected tasks.
- Pin the behavior for paid/private packs before publishing.
