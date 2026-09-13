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

Exit codes (a verdict verb — `--exit-trailer` carries it through a pipe): `0`
every selected test passed · `1` a test failed · `2` NOT VERIFIED — a test
could not be evaluated, or no agent tests are configured (`--allow-empty`
accepts an empty set explicitly) · `3` an `--id` that selects nothing (the
message names how many tests are configured and the closest ids). `--json`
always carries `exitCode`, `verdict` and `shortfalls`. `shrk quality` reports
the same verdict for its agent-tests gate: a not-verified test is never
counted as a failure there either.

MCP: `list_agent_tests`, `run_agent_test`. Packs contribute via
`agentTestFiles`.

These are especially important when shipping a pack that other repos
rely on — if your pack stops surfacing the expected pipeline/template
for a task, downstream agents quietly do the wrong thing.

## Two kinds of expectation

| Ranker-surfaced (order-sensitive; may flip on an unrelated content edit) | Registry existence (stable) |
|---|---|
| `expectedPipeline`, `expectedTemplates`, `expectedRules`, `expectedForbiddenActions`, `expectedVerificationCommands`, `mustNotInclude` | `expectedHelpers`, `expectedPlaybooks`, `expectedPolicies`, `expectedConstructs`, `expectedKnowledge` |

`expectedCommands` is a hybrid: it passes when the packet recommends the
command OR the command resolves against the live command index
(`shrk surface list`). A bare catalog form (`dev start`) is read as
`shrk dev start` — by the one command-string resolver, the same reading a
knowledge `command` reference and the self-config doctor get (a bare
`frobnicate` is an unknown verb everywhere; `git status` stays not-shrk).

Every existence answer comes from the shared reference registry — the set the
kind's `list` verb prints (`shrk rules list`, `shrk playbooks list`, …) — never
a private copy. Before round 11 the runner kept its own per-kind sets (pack
helpers missing), checked `expectedRules` against the KNOWLEDGE entries, and
checked `expectedCommands` against a property no inspection has (every correct
command failed).

Gate-rule `selfTest` fields are a third class again: they assert on a rule's
extracted set — see [gate-rules](gate-rules.md#what-a-selftest-asserts-plane-by-plane).

## Failure diagnostics

Each diagnostic carries `assertion` (`surfaced` | `exists`), `consulted`
(`{ kind, listVerb, size }` — the registry that answered) and a `code`:

| code | meaning |
|---|---|
| `unknown-id` | not registered at all — this expectation can never pass |
| `not-surfaced` | registered, but the ranker did not put it in the packet |
| `unknown-command` | the command string does not resolve (see `closest`) |
| `unverifiable` | the lookup could not run (registries not warmed; no command index outside the CLI) |
| `not-aggregated` | no relevant rule contributes this forbidden action / verification command |
| `surfaced-but-forbidden` | a `mustNotInclude` id was surfaced |

A test whose every failing expectation is `unverifiable` has
`verdict: 'not-verified'` (and `passed: false`) — `shrk test agent` exits `2`
for it, `1` for a real failure. MCP `run_agent_test` reads the same registry;
without a command index an unsurfaced `expectedCommands` entry is reported
`not-verified`, never a false failure.

When an expectation fails, the result includes per-id `diagnostics` with:

- whether the id exists in the inspection at all
- (context tests) top-ranked alternatives the ranker chose instead, with
  scoring reasons
- concrete suggestions: align `appliesWhen` with the task domain, add
  domain tags (e.g. `service`, `utility`, `route`), reference the id
  from a preset, or update the test if the expectation is wrong

`shrk test context|agent` prints diagnostics inline; `--json` exposes
them under `results[].diagnostics`.
