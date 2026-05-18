# Agent brief (`shrk brief`)

`shrk brief "<task>"` writes a single Markdown / JSON document that an AI
coding agent can read before doing anything in the repo. It bundles the
project overview, relevant rules / paths / templates, recommended
pipeline, action hints, forbidden actions, impact / boundary / policy /
ownership concerns, suggested commands, and a safety reminder.

## Modes

| Mode | When | Highlights |
| --- | --- | --- |
| `compact` | Quick lookup | Top rules, paths, templates, commands. |
| `implementation` (default for tasks with no diff) | Generating new code | Adds impact, boundary, policy concerns. |
| `review` (default when `--since/--staged/--files` and no task) | Reviewing a diff | Focuses on changed files, ownership, coverage, drift. |
| `full` | Everything | Above + coverage + drift + baseline. |
| `handoff` (default when `--session` / `--bundle` and no task) | Picking up another agent's work | Session / bundle summary, next action. |

Override with `--mode compact|full|review|implementation|handoff`.

## Inputs

```
shrk brief "<task>"
shrk brief "<task>" --since <ref>
shrk brief "<task>" --staged
shrk brief "<task>" --files a,b
shrk brief "<task>" --bundle <bundleId>
shrk brief "<task>" --session <sessionId>
shrk brief "<task>" --output brief.md
shrk brief "<task>" --json
shrk brief "<task>" --max-tokens 6000
```

`--output` writes Markdown to disk (parent dirs created). `--json` emits
the structured `IAgentBrief` payload.

## Safety

Every brief ends with the safety reminder:

> MCP is read-only. Use CLI for writes. Apply requires explicit human
> action.

## Per-task risk (R20)

When the input includes a `task`, the brief output now also carries an
optional `taskRisk` field — the full `ITaskRiskReport`. The Markdown body
is unchanged (the risk is exposed via the JSON envelope and via the
sister command `shrk risk "<task>"`). See `docs/safety-model.md` for the
risk model itself.

## Chunking & budgets (R12)

Large briefs can blow an agent's context budget. Use chunking to split
the brief into ordered files:

```bash
shrk brief "<task>" --chunk                       # print chunks to stdout
shrk brief "<task>" --chunk --output-dir .sharkcraft/briefs/<id>
shrk brief "<task>" --section-budget rules=600,impact=400
shrk brief "<task>" --max-tokens 4000
```

Chunked output writes a `00-index.md` listing the rest in order, then
one Markdown file per section (`01-task.md`, `02-rules.md`, …). Every
chunk includes the safety reminder at the bottom.

Section budgets cap individual section sizes (token estimate ≈ chars/4).
Trimmed sections end with a `_…section trimmed_` marker so the agent
knows nothing went missing silently.

MCP `create_agent_brief` accepts `chunked: true` and `sectionBudgets` and
returns the `chunks[]` array without writing files.

### MCP chunk delivery (R13)

For agents that don't want one big payload, three additional tools deliver
chunks lazily without touching the filesystem:

| Tool | Returns |
|---|---|
| `start_agent_brief_chunks` | A deterministic `briefId` + chunk index. Caches the brief in-memory for one hour. |
| `get_agent_brief_chunk_index` | The chunk index for a previously-started brief. |
| `get_agent_brief_chunk` | One chunk by `order` or `sectionId`. |

The cache key is a hash of the input fields, so calling
`start_agent_brief_chunks` twice with identical input is idempotent.

### Cache resilience (R14)

The chunk cache lives in-process, so an MCP server restart clears it.
R14 makes that recoverable instead of mysterious:

- `start_agent_brief_chunks` now returns `cacheTtlMs`, `expiresAt`,
  `deterministicInputHash`, `serverStartedAt`, and `canRecreate: true`
  alongside the chunk index.
- `get_agent_brief_chunk` / `get_agent_brief_chunk_index` return
  `{ isError: true, error: { code: 'cache-miss', details: { canRecreate, recommendedCall } } }`
  when the briefId is unknown. The recommended call is always
  `start_agent_brief_chunks` with the same input — the briefId is
  deterministic, so re-creating recovers the same id.

If the agent already has the original input handy, the recovery loop is:
detect `code: 'cache-miss'` → re-call `start_agent_brief_chunks` with
the same arguments → continue with the same `briefId`.

### Delta / compare with a previous brief (R15)

When `start_agent_brief_chunks` is called with a `task` that matches a
previously-cached brief, the response now includes:

```jsonc
{
  "reused": false,
  "previousBriefId": "8c…",
  "delta": { "reused": 5, "changed": 1, "unchanged": 5, "new": 1, "removed": 0 },
  "sectionHashes": { "task": "<sha256>", "rules": "<sha256>", "…": "…" }
}
```

CLI side, `shrk brief "<task>" --chunk --compare-with <dir-of-prev-chunks>`
prints the changed/unchanged/new/removed section counts so reviewers
can see exactly which parts of the brief shifted between runs:

```
Compare vs /tmp/brief-a:
  unchanged=4  changed=2  new=1  removed=0
  changed:
    ~ task   (01-task.md)
    ~ impact (05-impact.md)
  new:
    + policy (07-policy.md)
```

## MCP

`create_agent_brief` — same payload, read-only.

## Dev workflow integration

```bash
shrk dev start "<task>" --brief
```

writes `brief.md` inside the new session directory and records the path
on the session state. The dev report includes the brief path.
