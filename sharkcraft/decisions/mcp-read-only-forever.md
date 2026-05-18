---
id: mcp-read-only-forever
title: MCP server is read-only forever
status: accepted
date: 2026-05-15
---

# MCP server is read-only forever

## Context

LLMs invoke MCP tools frequently, often without human confirmation. The
SharkCraft engine ships a registered MCP server alongside the CLI.

Allowing the MCP surface to write would mean any LLM call could mutate
source, generated artefacts, packs, or the dashboard state — bypassing
the human-gated `shrk apply` step.

## Decision

Every tool registered in `packages/mcp-server/src/tools/` MUST be
read-only. Tools may compute, render, preview, or recommend, but must
never:
  - call `writeFile`, `writeFileSync`, `mkdirSync`, `appendFileSync`,
    `unlinkSync`, `rmSync`, or any node:fs write API.
  - spawn shell commands that mutate files.
  - update remote state.

When a tool returns "next steps," it returns the next *CLI* command for
the human to run — never executes the step itself.

## Consequences

- Every new MCP tool gets a `next` hint that names the corresponding
  CLI command.
- Adding a write capability requires a hard refactor + an ADR superseding
  this one.
- The policy `sharkcraft.mcp-read-only` is the runtime gate; `shrk
  safety audit --deep` is the daily check.

## Related policies

- sharkcraft.mcp-read-only
- sharkcraft.helper-preview-only-mcp
- sharkcraft.no-destructive-without-approval

## Related commands

- shrk safety audit --deep
- shrk commands doctor
- shrk policy run
