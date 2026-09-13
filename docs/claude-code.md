# Claude Code MCP configuration

SharkCraft's MCP server runs over stdio. Claude Code launches MCP servers from
a `mcpServers` config entry. The server picks its target repository from (in
priority order):

1. `--cwd <path>` flag passed to the server binary.
2. `SHARKCRAFT_PROJECT_ROOT` environment variable.
3. The directory Claude Code spawns the process in.

So in nearly every real setup you want either `args: ["--cwd", "..."]` or the
env variable. Otherwise the server will target the wrong directory and produce
empty results.

## Local development config (running from the SharkCraft monorepo)

```json
{
  "mcpServers": {
    "sharkcraft": {
      "command": "bun",
      "args": [
        "run",
        "/absolute/path/to/sharkcraft/packages/mcp-server/src/main.ts"
      ],
      "env": {
        "SHARKCRAFT_PROJECT_ROOT": "/absolute/path/to/target-repo"
      }
    }
  }
}
```

Or, use the `--cwd` flag instead of the env var:

```json
{
  "mcpServers": {
    "sharkcraft": {
      "command": "bun",
      "args": [
        "run",
        "/absolute/path/to/sharkcraft/packages/mcp-server/src/main.ts",
        "--cwd",
        "/absolute/path/to/target-repo"
      ]
    }
  }
}
```

## Installed config (the npm package)

`@shrkcrft/mcp-server` ships a `shrk-mcp` bin (from 0.1.0-alpha.31; earlier
releases published no bin, so there was nothing for `bunx` / `npx` to run).
Install it once and point Claude Code at the bin:

```bash
bun add -g @shrkcrft/mcp-server     # or: npm install -g @shrkcrft/mcp-server
```

```json
{
  "mcpServers": {
    "sharkcraft": {
      "command": "shrk-mcp",
      "args": ["--cwd", "/absolute/path/to/target-repo"]
    }
  }
}
```

Or run it without a global install — the bin's name differs from the
package's, so name the package explicitly:

```json
{
  "mcpServers": {
    "sharkcraft": {
      "command": "bunx",
      "args": ["--package", "@shrkcrft/mcp-server", "shrk-mcp"],
      "env": {
        "SHARKCRAFT_PROJECT_ROOT": "/absolute/path/to/target-repo"
      }
    }
  }
}
```

Use `"command": "npx", "args": ["-y", "--package", "@shrkcrft/mcp-server",
"shrk-mcp"]` if you don't have Bun installed on the Claude Code host.
SharkCraft works on Bun and Node 22+; Bun is the supported runtime. If the
installed tool is broken (a workspace dependency it needs is not linked), the
bin exits `70` with one line naming the missing package instead of a Node
resolver stack — see [exit-codes.md](exit-codes.md).

## Verifying the server is wired correctly

Inside Claude Code, after restarting with the new config, try:

> "Use the `inspect_workspace` MCP tool and report the project root."

If the response shows the *target* repo, the wiring is correct. If it shows
your home dir or a system temp dir, the server didn't receive the target —
re-check the env var / `--cwd` arg.

## Recommended agent usage pattern

After the server is connected:

1. **`inspect_workspace`** — confirms the target repo and its frameworks/scripts.
2. **`get_agent_instructions`** — short briefing on how to use the rest of the tools.
3. **`get_relevant_context`** — for each new task. Pass `task` plus a tight
   `maxTokens` (2000–3500). The response is structured by section
   (`Relevant Rules`, `Relevant Path Conventions`, …) with entry ids so you can
   cite them.
4. **`get_relevant_rules`** — when generating code, the targeted version of
   `list_rules`.
5. **`list_templates`** → **`get_template`** — discover the right generator.
6. **`create_generation_plan`** — never writes. Returns the plan with
   conflict flags. Surface the plan to the user.
7. **Apply via the CLI** — `shrk gen <template> <name> --write` once the user
   approves. Agents do not write files directly through MCP.

## Common mistakes

- **No `--cwd` and no env var.** The server falls back to `process.cwd()`,
  which in Claude Code is usually wrong.
- **Relative `--cwd`.** It works (it's resolved against the spawn cwd) but the
  result depends on where Claude Code starts the process. Prefer absolute
  paths in MCP configs.
- **Stale process.** If you edit `sharkcraft/*.ts`, the loaded inspection is
  cached in the running server. Restart the MCP server to pick up changes.
