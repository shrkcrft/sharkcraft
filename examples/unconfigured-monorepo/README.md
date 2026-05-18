# unconfigured-monorepo

A small fixture used to dogfood `shrk onboard` against a monorepo layout:

- `apps/web` — a deployable app
- `packages/core` — shared domain types
- `packages/ui` — UI components
- `packages/api` — HTTP server bindings

Run:

```bash
bun run shrk --cwd examples/unconfigured-monorepo onboard --dry-run
```

You should see a `monorepoSummary` block summarising the layout and proposing
boundary candidates.
