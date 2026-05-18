# Fix preview system

R31 introduces a safe, preview-only fix workflow. Default is preview;
nothing under source is ever modified. `--write-preview` writes only
under `.sharkcraft/fixes/`.

## Commands

```bash
shrk fix list                         # supported fix kinds
shrk fix doctor                       # how many actionable fixes
shrk fix preview --action-hints       # stubbed action-hint scaffolds
shrk fix preview --knowledge-stale    # stale-reference suggestions
shrk fix preview --template-drift     # template-drift remediation hints
shrk fix preview --target <id>        # focus on one id
shrk fix preview --write-preview      # write .sharkcraft/fixes/*.preview.md
```

## Action-hint stubs

Generated bodies are explicitly marked `// needs-human-fill` and use
TODO placeholders. Doctor continues to warn until the human fills in
concrete values.

```ts
actionHints: {
  commands: [/* TODO: relevant shrk commands */],
  mcpTools: [/* TODO: read-only MCP tool names */],
  forbiddenActions: [/* TODO: things the agent must not do */],
  verificationCommands: [/* TODO: shrk check / lint / tsc invocations */],
  writePolicy: /* TODO: 'human-only' | 'cli-only' | 'forbidden' */,
  relatedTemplates: [/* TODO: template ids */],
  relatedPathConventions: [/* TODO: path convention ids */],
}
```

## Schema

`sharkcraft.fix-preview/v1`.

## MCP

- `preview_fix` — read-only.
- `list_fix_kinds` — read-only.

## Safety

- The inspector module never writes.
- The CLI writes only under `.sharkcraft/fixes/` and only with explicit
  `--write-preview`.

## R39 — surfaced from doctor

`shrk doctor` now prints a one-line pointer ("Draft patch available — run
`shrk fix preview`…") when any preview-eligible warning is active
(action-hints, knowledge-stale, template-drift, self-config,
pack-conflict, stale-pack-signature). The pointer never auto-applies a
patch; it only points the operator at the preview command.
