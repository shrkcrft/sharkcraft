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

Packs contribute via `contributions.playbookFiles`. Extra local files go in
`sharkcraft.config.ts` as `playbookFiles: ['pb/extra.ts']`, relative to
`sharkcraft/`. They are loaded in addition to `playbooks.ts` /
`playbooks/index.ts`.

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

## Ranking (`playbooks recommend`, MCP `recommend_playbooks`)

Scored through THE term matcher (`match-terms.ts`, shared with routing hints):

- the whole task contained in the title: +10;
- each tag +3, each taskKind +4 — matched in the playbook's `matchMode`
  (default `tokens`: tag `capability-pack` matches "add a capability pack",
  and `ci` no longer fires inside "pricing"); `matchMode: 'substring'` keeps
  the legacy raw containment;
- each example +3 when its content terms overlap the task's by ≥ 0.5 (Jaccard);
- +1 per distinct task content term found in the title/description, capped at
  +3 — only with ≥ 2 shared terms or alongside another signal, so a single
  common verb ("add") never recommends a playbook on its own.

A playbook file that fails to import (or a pack-declared one that is missing)
used to be swallowed. It is now a `playbook-load-failed` /
`playbook-missing-file` finding in `shrk self-config doctor`, and the file
counts as an unexamined `playbook files` unit — the verdict is `unverified`,
never a healthy registry.

**Required fields (round 12).** A playbook needs a non-empty string `id` and
a `steps` array. One without an id used to be dropped silently, and one
without `steps` was ACCEPTED and crashed `shrk self-config doctor`. Both are
now REJECTED entries: `shrk playbooks list` ends with `⚠ N entries rejected
from <file>: …`, and the self-config doctor reports `playbook-invalid` (error).

## MCP (read-only)

- `list_playbooks`
- `get_playbook`
- `recommend_playbooks`
- `preview_playbook_script`
