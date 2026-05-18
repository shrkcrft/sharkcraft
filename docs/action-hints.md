# Action hints

Action hints are optional structured guidance attached to a knowledge entry.
They answer "what should the agent do?" — not just "what is the rule?".

## Shape

```ts
interface IActionHints {
  commands?: { command: string; purpose?: string; when?: string; required?: boolean }[];
  mcpTools?: { tool: string;   purpose?: string; when?: string; required?: boolean }[];
  preferredFlow?: string[];          // ordered step ids / tool names / commands
  forbiddenActions?: string[];
  relatedTemplates?: string[];       // template ids
  relatedPathConventions?: string[]; // path-convention ids
  relatedKnowledge?: string[];       // other knowledge ids
  verificationCommands?: string[];   // run after generation
  safetyNotes?: string[];
  requiresHumanReview?: boolean;
  writePolicy?: 'cli-only' | 'mcp-allowed' | 'none';
}
```

## When to add hints to an entry

- **Rules that drive an action** (e.g. "shrk gen is dry-run by default" → list
  commands + preferred flow).
- **Architecture rules with clear "do this / don't do this"** (e.g. layer
  order, no embedded defaults).
- **Workflow entries** (`plugin.design-sequence`, `plugin.quickstart`) — these
  should always carry hints; they exist to drive the agent.

Descriptive entries (`project.overview`, `tech-stack`) don't need hints.

## How the context builder uses hints

`buildContext` aggregates hints across every entry it includes and emits a
single composite **"Agent Actions"** section at the bottom of the context.
It de-dupes commands / tools / forbidden actions / verification commands.
For `preferredFlow`, the highest-priority entry that defines a flow wins —
no merge — to avoid contradictions.

The result is one consistent block the agent can follow.

## MCP exposure

- `get_knowledge { id }` returns the entry with `actionHints` intact.
- `get_relevant_rules` returns each rule plus its `actionHints`.
- `get_relevant_context` includes the aggregated **Agent Actions** section.
- `get_action_hints { task, entryIds?, limit? }` is the dedicated aggregator
  — returns commands, mcpTools, preferredFlow, forbiddenActions, etc. in one
  bundle.

## Aggregation rules

When `aggregateActionHints` merges entries:

| Field | Strategy |
|---|---|
| `commands` | Union, dedupe by `command` string. |
| `mcpTools` | Union, dedupe by `tool` name. |
| `preferredFlow` | Highest-priority entry that defines one wins. |
| `writePolicy` | First non-empty wins (priority-ordered). |
| `forbiddenActions` / `verificationCommands` / `safetyNotes` | Union, dedupe. |
| `relatedTemplates` / `relatedPathConventions` / `relatedKnowledge` | Union, dedupe. |
| `requiresHumanReview` | OR across entries. |

## Example

```ts
defineKnowledgeEntry({
  id: 'generation.dry-run-by-default',
  title: 'shrk gen is dry-run by default',
  type: 'rule',
  priority: 'critical',
  scope: ['generation'],
  tags: ['safety', 'generator'],
  appliesWhen: ['generate-code'],
  content: '...',
  actionHints: {
    mcpTools: [{ tool: 'create_generation_plan', required: true }],
    commands: [
      { command: 'shrk gen <id> <name> --dry-run --save-plan <plan.json>' },
      { command: 'shrk apply <plan.json>' },
    ],
    preferredFlow: [
      'inspect_workspace',
      'get_relevant_context',
      'get_relevant_rules',
      'get_template',
      'create_generation_plan',
      'human_review',
      'shrk apply <plan.json>',
    ],
    forbiddenActions: ['Do not write files through MCP.', 'Do not bypass dry-run.'],
    requiresHumanReview: true,
    writePolicy: 'cli-only',
  },
});
```
