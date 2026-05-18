---
id: doc.development
title: Development guide
type: technical
priority: medium
scope: backend
tags: doc, development
---

# Development

## Commands

```bash
bun install
bun run start         # bun run src/server.ts
bun test
```

## Adding a service

1. Run `shrk --cwd . context --task "<task>" --max-tokens 3000` to retrieve rules + path conventions.
2. Run `shrk --cwd . templates list` to find the right template.
3. Run `shrk --cwd . gen typescript.service <kebab-name> --var className=<PascalName> --dry-run`.
4. Inspect the plan. If it's conflict-free, re-run with `--write`.
5. Wire the new service into `src/server.ts`.
6. Add a `tests/<name>.spec.ts`.

## Adding an endpoint

- The route lives in `src/server.ts`. Keep it thin.
- Business logic stays in `src/services/`.
- Validate request inputs (see rule `http.validate-input`).
