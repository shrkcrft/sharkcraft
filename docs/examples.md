# Examples

This monorepo ships three example consumers under `examples/`:

| Example | Purpose |
|---|---|
| `generic-typescript-app` | The default reference. Plain TypeScript, no framework. |
| `angular-style-app` | Angular-flavoured rules/paths/templates (knowledge only). |
| `react-style-app` | React-flavoured rules/paths/templates (knowledge only). |

The framework-style examples are intentionally **knowledge-only** — they're not runnable apps; they exist to show how the `sharkcraft/` folder might be tuned for a specific stack.

## Running CLI commands against an example

From the repo root:

```bash
cd examples/generic-typescript-app
bun run ../../packages/cli/src/main.ts inspect
bun run ../../packages/cli/src/main.ts knowledge list
bun run ../../packages/cli/src/main.ts context --task "create a user profile service"
bun run ../../packages/cli/src/main.ts gen typescript.service user-profile --dry-run
```

After `bun install` the workspace symlinks are set up; you can also run:

```bash
cd examples/generic-typescript-app
bun x shrk inspect
```
