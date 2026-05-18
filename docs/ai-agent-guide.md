# AI Agent Guide

This guide is for AI agents (Claude, etc.) connected to a SharkCraft-instrumented repository through MCP.

## Default behavior

- **Do not read every file.** Use MCP tools to retrieve only what you need.
- **Use `get_relevant_context`** at the start of a task; pass a tight `maxTokens` (2000–3500 is plenty for most coding tasks).
- **Use `get_relevant_rules`**, not `list_rules`, unless you need an inventory.
- **Use `list_templates` → `get_template` → `create_generation_plan`** before any generation.

## Resources vs tools

SharkCraft also exposes **MCP resources** so you can fetch background info
without a tool call — useful for clients that prefer the resource model:

- `sharkcraft://overview`
- `sharkcraft://agent-instructions`
- `sharkcraft://knowledge/<id>`
- `sharkcraft://template/<id>`
- `sharkcraft://docs/<rel-path>`

Use `resources/list` to enumerate and `resources/read { uri }` to fetch.
Resources are read-only by design.

## Generation flow

MCP **never** writes files. Use this flow:

1. **Pick a template.** `search_templates` if you don't know the id, then
   `get_template` to inspect variables and notes.
2. **Plan.** `create_generation_plan { templateId, name, variables }`. Plans
   are computed against the live project; refused if any target path escapes
   the project root or collides with existing content.
3. **Show the plan to the user.** Quote the entry ids you used.
4. **Save the plan.** Use your file-write tool to save the plan JSON returned
   by `create_generation_plan` to e.g. `.sharkcraft/plans/<timestamp>.json`,
   wrapping it in the `sharkcraft.plan/v1` envelope:

   ```json
   {
     "schema": "sharkcraft.plan/v1",
     "templateId": "...",
     "name": "...",
     "variables": { "...": "..." },
     "projectRoot": "/abs/path",
     "createdAt": "ISO timestamp",
     "expectedChanges": [{ "type": "create", "relativePath": "...", "sizeBytes": 0 }]
   }
   ```

5. **Ask the user to apply.** They run `shrk apply <plan.json>` from the CLI.
   SharkCraft regenerates the plan fresh, verifies it matches the saved
   `expectedChanges`, and writes.

Alternatively, if the user prefers a one-shot CLI flow, they can run
`shrk gen <id> <name> --var k=v --dry-run --save-plan <file>` themselves and
then `shrk apply <file>`.

## Path conventions

Before placing a new file, call `list_path_conventions` or
`explain_generation_target` to confirm the path matches the project's
convention.

## Quoting sources

When you base a recommendation on a knowledge entry, quote its **id** so the
user can trace it.

## Safety

- Never propose writes outside the project root.
- Never propose overwriting a file without showing the plan first.
- Never bypass `--write` / `apply` from the CLI by writing through your own
  file tool.

## Self-help

If you need a refresher on how to use this repo, call `get_agent_instructions`
(or read `sharkcraft://agent-instructions`).
