# Task context

Three commands narrow SharkCraft context down to a specific task.

## `shrk understand-task "<task>"`

Returns intent + relevant rules + likely files + risks + recommended
commands + a next safe command. Combines:

- `buildTaskPacket` (relevant rules/paths/templates).
- `classifyChangeIntent` (intent + risk hints).
- `buildTaskRiskReport` (memory-weighted risk).
- `buildAgentBrief` (next safe command).
- `buildRepositoryKnowledgeModel` (transformational intents).

```bash
shrk understand-task "<task>" --preset modern-angular --format markdown
shrk understand-task "<task>" --save                       # writes .sharkcraft/context/task-contexts/<slug>.json
```

Read-only unless `--save` is passed.

## `shrk validate-change`

Validates a proposed or staged change. Detects boundary-suspect edits,
edits to generated files, missing test neighbours, and doc contradictions
that the in-flight change would touch.

```bash
shrk validate-change                               # working tree changes (git)
shrk validate-change --staged                      # staged changes
shrk validate-change --since main                  # diff vs ref
shrk validate-change --files a.ts,b.ts             # explicit list
shrk validate-change --json
```

Read-only.

## `shrk context build|refresh|status`

```bash
shrk context build --task "<task>" --preset modern-angular
shrk context refresh                                # re-build the most recent task
shrk context status                                 # what's saved
```

Writes under `.sharkcraft/context/`:

```
.sharkcraft/context/
├── status.json
└── task-contexts/
    ├── <slug>.json
    └── <slug>.md
```

## MCP

- `understand_task` — read-only.
- `get_task_context` — read-only.
- `validate_change_context` — read-only.

All three return the structured payload + a next-command hint.
