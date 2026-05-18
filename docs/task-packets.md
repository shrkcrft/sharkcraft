# Task packets

A **task packet** is the single most useful starting point for an AI agent
working on this repo. One call, one bundle, everything the agent needs.

```bash
shrk task "create a user profile service"
```

Returns:

- **Project overview** — name, frameworks, profile tags.
- **Recommended pipeline(s)** — typically `feature-dev` or `safe-generation`.
- **Preset recommendations** — informational only.
- **Relevant rules / paths / templates** — sourced from the local
  sharkcraft folder and any installed packs.
- **Action hints** aggregated across the matching entries.
- **Recommended CLI commands** — concrete `shrk` calls.
- **Recommended MCP tools** — what to call from Claude Code / Cursor.
- **Forbidden actions** — what NOT to do.
- **Verification commands** — what to run after the change lands.
- **Human-review checkpoints** — pipeline steps marked `humanReview: true`.
- **Token-budgeted context body** — the deterministic narrative the agent
  would normally need to skim docs to learn.

## MCP

The same bundle is available over MCP:

```jsonc
{
  "method": "tools/call",
  "params": {
    "name": "get_task_packet",
    "arguments": { "task": "create a user profile service", "maxTokens": 3500 }
  }
}
```

## Why it exists

Most "agent + project context" tooling either:

- Dumps the entire README into the context window (high cost, low signal), or
- Hopes the agent does retrieval right (it usually doesn't).

A task packet is **deterministic orchestration over the existing services**.
No AI calls. No retrieval magic. Just filtered rules + matching pipeline +
action hints, all in one JSON payload.

## Ranking

The packet uses a deterministic ranker over `appliesWhen` / tags / scope /
priority / title / description / related templates and paths / pipeline
step ids. No AI, no embeddings — pure scoring with reasons.

```bash
shrk task "<task>" --explain-ranking
shrk task "<task>" --json    # rankingReasons is always included in JSON
```

If one template clearly dominates, the packet also includes a
`suggestedGen` block with concrete dry-run + apply commands. Variables
that can't be extracted from the task wording stay as `<vars>` placeholders
— agents must call `shrk templates vars <id>` rather than hallucinate
values.

## Use it as the agent's bootstrap

Typical Claude Code / Cursor flow:

1. Call `get_task_packet` once with the user's task.
2. Read `recommendedPipelines` and `recommendedCliCommands`.
3. Generate proposed plan; hand it to the human via `shrk apply`.
4. Run the `verificationCommands` listed in the packet.

The packet is read-only — it never writes. Generation goes through
`shrk gen → shrk apply` on the CLI, by a human.
