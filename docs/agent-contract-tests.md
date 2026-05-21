# Agent contract tests

While context tests pin retrieval (`mustInclude`/`mustNotInclude` on the
context body), agent contract tests pin the **task packet shape** — what
`shrk task` and MCP `get_task_packet` will return for a given task.

```ts
// sharkcraft/agent-tests.ts
import { defineAgentContractTest } from '@shrkcrft/inspector';

export default [
  defineAgentContractTest({
    id: 'service-packet',
    task: 'create a new user profile service',
    expectedPipeline: 'feature-dev',
    expectedTemplates: ['app.service'],
    expectedRules: ['repo.architecture.respect-boundaries'],
    expectedForbiddenActions: ['Do not write files through MCP.'],
    expectedVerificationCommands: ['bun x tsc -p tsconfig.base.json --noEmit'],
  }),
];
```

Run:

```bash
shrk test agent
shrk test agent --id <id>
shrk test agent --json
```

MCP: `list_agent_tests`, `run_agent_test`. Packs contribute via
`agentTestFiles`.

These are especially important when shipping a pack that other repos
rely on — if your pack stops surfacing the expected pipeline/template
for a task, downstream agents quietly do the wrong thing.

## Failure diagnostics

When an expectation fails, the result includes per-id `diagnostics` with:

- whether the id exists in the inspection at all
- (context tests) top-ranked alternatives the ranker chose instead, with
  scoring reasons
- concrete suggestions: align `appliesWhen` with the task domain, add
  domain tags (e.g. `service`, `utility`, `route`), reference the id
  from a preset, or update the test if the expectation is wrong

`shrk test context|agent` prints diagnostics inline; `--json` exposes
them under `results[].diagnostics`.
