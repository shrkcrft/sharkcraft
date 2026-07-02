# Command-first context (R33)

R33 added the canonical agent task entrypoint and improved the existing
`shrk task` / `shrk context` outputs so commands are surfaced first.

## MCP — `prepare_agent_task`

The recommended first call an AI agent makes. Returns:

- task + intent hints,
- confidence + missing signals,
- primary / inspection / generation / validation commands,
- relevant lifecycle profiles + conventions,
- routing hints with reasons,
- safety notes,
- next safe action.

Schema: `sharkcraft.agent-task-prep/v1`.

## CLI

- `shrk task "<task>"` and `shrk context --task "<task>"` now render the
  **full body by default** in text mode — parity with `shrk why`, `shrk reuse`,
  and `shrk knowledge get` — and **auto-widen the token budget** so the rich
  sections (architecture, conventions, paths, workflows) aren't silently dropped
  to fit a terse cap.
- `--summary` (alias `--brief`) opts back into the terse, budget-capped view.
- `--commands-first` / `--actions-only` still give the terse commands-first view
  (what to run, not the full context body).
