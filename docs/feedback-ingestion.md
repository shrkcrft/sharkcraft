# Feedback ingestion (R29)

`shrk feedback` parses freeform markdown/text feedback into structured
findings the agent (or a human) can convert into a backlog.
Deterministic — no AI.

## Commands

```
shrk feedback ingest <file> [--json]
shrk feedback summarize <file> [--json]
shrk feedback actions <file> [--json]
shrk feedback convert-to-backlog <file> [--output <path>]
```

`shrk feedback <file>` (no verb) defaults to `ingest`.

## Buckets

Headings like `# Good`, `## Bad`, `### Missing`, `## Pain points`
seed the bucket of subsequent bullets. Unrecognised headings keep the
finding in `other`.

| bucket | severity default |
|---|---|
| good | info |
| bad | minor |
| missing | info |
| pain-point | minor |
| other | info |

Severity is upgraded by keywords (`broken`, `crash`, `fail` → major).

## Tags / target areas

A built-in keyword scan adds tags and a target area per finding —
e.g. "changed-only boundary" → tag `changed-only`, target
`boundaries-changed-only`. Target areas drive the suggested follow-up
commands and the "suggested next round" summary.

## MCP

`preview_feedback_actions({ text, sourceFile? })` returns the same
report over the read-only MCP surface.

## When to use

- After a dogfood round, paste the user feedback into a markdown file
  and run `shrk feedback convert-to-backlog`.
- During release retro, ingest the contributors' notes.

Schema: `sharkcraft.feedback-ingestion/v1`.

## R30 — Pack-extensible feedback rules

`IFeedbackRule` (schema `sharkcraft.feedback-rule/v1`) lets packs ship
their own categorisation rules. Local file
`sharkcraft/feedback-rules.ts` is the SharkCraft-engine surface;
pack contributions come via `feedbackRuleFiles[]` in the pack manifest.

```ts
defineFeedbackRule({
  id: 'app.layout-friction',
  title: 'Layout engine friction',
  keywords: ['layout', 'layout-engine'],
  phrases: ['layout state'],
  targetArea: 'layout',
  tag: 'layout',
  severity: 'minor',
  suggestedActions: ['shrk trace layout --deep'],
});
```

### Commands

```
shrk feedback rules list [--json]
shrk feedback rules doctor [--json]
shrk feedback ingest <file> --with-pack-rules
shrk feedback actions <file> --with-pack-rules
```

The built-in keyword scanner still runs first. Pack rules supplement —
they cannot override the built-in target area when a built-in rule also
matches the same text (the first-match-wins target keeps existing
classifications stable).

### Validation

`shrk feedback rules doctor` flags:

- **error**: missing id / duplicate id / rule has no
  keywords / phrases / regexes.
- **warning**: missing title / no targetArea / no suggested actions.

### MCP

- `list_feedback_rules` — read-only.
- `get_feedback_rule({ id })` — read-only.
