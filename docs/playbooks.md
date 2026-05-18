# Playbooks / recipes (`shrk playbooks ...`)

A **playbook** is a structured, reusable runbook — a named recipe that
combines a preset, a pipeline, recommended templates, and a step-by-step
list of commands / MCP tools / verification gates. Playbooks are
**never** executed automatically; they are documents the agent or human
reads before acting.

## Defining playbooks

In `sharkcraft/playbooks.ts`:

```ts
import { definePlaybook } from '@shrkcrft/plugin-api';

export default [
  definePlaybook({
    id: 'add-service',
    title: 'Add a new HTTP service',
    description: 'Generate a service skeleton, route, validation, tests.',
    tags: ['service', 'http', 'scaffold'],
    taskKinds: ['generate', 'feature'],
    recommendedTemplateIds: ['typescript.service', 'typescript.test'],
    recommendedPipelineIds: ['gen-feature-flow'],
    steps: [
      {
        id: 'context',
        title: 'Load context',
        commands: ['shrk context --task "<task>"'],
      },
      {
        id: 'plan',
        title: 'Dry-run generate',
        commands: [
          'shrk gen typescript.service <name> --dry-run --save-plan /tmp/plan.json',
        ],
      },
      {
        id: 'apply',
        title: 'Apply (human approval)',
        humanReview: true,
        commands: ['shrk apply /tmp/plan.json --verify-signature'],
        verificationCommands: ['bun test', 'shrk check boundaries'],
      },
    ],
  }),
];
```

Packs contribute via `contributions.playbookFiles`.

## CLI

```
shrk playbooks list
shrk playbooks get <id>
shrk playbooks recommend "<task>"
shrk playbooks runbook <id>
shrk playbooks brief <id>
shrk playbooks script <id>     # R12
shrk playbooks preview <id>    # R12
shrk playbooks validate <id>   # R12
```

## Script / preview / validate (R12)

```bash
shrk playbooks script <id> [--task "<task>"] [--output <path>] [--json]
shrk playbooks preview <id> [--json]
shrk playbooks validate <id> [--json]
```

`script` renders a bash-like preview file (annotated, never executed).
Human-review markers and verification commands stay as comments.
`preview` returns the structured plan (steps, mcpTools, verification,
safetyNotes). `validate` checks references against the registered
templates / pipelines and flags duplicate or empty steps.

MCP: `preview_playbook_script` returns `{ preview, script, validation }`.

## MCP (read-only)

- `list_playbooks`
- `get_playbook`
- `recommend_playbooks`
- `preview_playbook_script`
