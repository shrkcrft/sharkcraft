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

- `shrk task "<task>"` continues to emit the R31 human + JSON shapes.
- `shrk context --task "<task>"` is unchanged in form; future rounds
  will add an inline `--commands-first` flag for human-friendly default
  output. Today the equivalent is `shrk search "<task>" --actions-only`.
