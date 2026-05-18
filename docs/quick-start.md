# Quick start

## Requirements

- Bun >= 1.1

## Install

```bash
bun install
bun run typecheck
```

## Run the CLI

```bash
bun run shrk -- help
bun run shrk -- init           # creates ./sharkcraft/ in cwd
bun run shrk -- inspect
bun run shrk -- knowledge list
bun run shrk -- rules relevant --task "generate a TypeScript service"
bun run shrk -- context --task "generate a TypeScript service" --max-tokens 3000
bun run shrk -- templates list
bun run shrk -- gen typescript.service user-profile --dry-run
bun run shrk -- gen typescript.service user-profile --write
bun run shrk -- doctor
```

## Run the MCP server

```bash
bun run mcp                    # equivalent to: bun run packages/mcp-server/src/main.ts
# or
bun run shrk -- mcp serve
```

The server speaks JSON-RPC over stdio. Tools are listed via the `tools/list` MCP method.
