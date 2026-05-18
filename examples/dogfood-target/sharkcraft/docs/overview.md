---
id: doc.overview
title: Dogfood-target overview
type: technical
priority: medium
scope: typescript, bun, backend
tags: doc, overview
appliesWhen: onboard
---

# dogfood-target

A minimal Bun-native HTTP service used to dogfood SharkCraft from an
external-feeling repository.

## Layout

- `src/server.ts` — `Bun.serve()` entry point. Thin routing only.
- `src/services/` — application services.
- `src/utils/` — pure helpers.
- `tests/` — `*.spec.ts` files run via `bun test`.
- `sharkcraft/` — SharkCraft project knowledge.

## Endpoints

- `GET /health` — liveness check.
- `GET /users/:id` — fetch a user.

## SharkCraft entry points to try

```bash
bun run /path/to/sharkcraft/packages/cli/src/main.ts \
  --cwd examples/dogfood-target inspect

bun run /path/to/sharkcraft/packages/cli/src/main.ts \
  --cwd examples/dogfood-target context \
  --task "generate a user profile service" --max-tokens 3000

bun run /path/to/sharkcraft/packages/cli/src/main.ts \
  --cwd examples/dogfood-target gen typescript.service user-profile --dry-run
```
