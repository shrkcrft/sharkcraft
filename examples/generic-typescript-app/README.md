# Generic TypeScript app — SharkCraft example

This example shows the *consumer* side: a normal TypeScript project that has its
own `sharkcraft/` folder describing rules, paths, templates, and docs.

From the SharkCraft repo root:

```bash
cd examples/generic-typescript-app
bun run ../../packages/cli/src/main.ts inspect
bun run ../../packages/cli/src/main.ts knowledge list
bun run ../../packages/cli/src/main.ts context --task "generate a TypeScript service" --max-tokens 2000
bun run ../../packages/cli/src/main.ts gen typescript.service user-profile --dry-run
```

Or, with the workspace symlinks resolved:

```bash
cd examples/generic-typescript-app
bun x shrk inspect
```
