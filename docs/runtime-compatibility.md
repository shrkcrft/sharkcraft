# Runtime compatibility

SharkCraft is **Bun-first** for local development. The published CLI and
MCP server should also run under **Node** so that adopters who don't use
Bun can still consume them.

This document records the current state and the audit tooling.

## Auditing

```bash
bun run compat:node                  # source scan only
bun run compat:node:cli --build      # build dist/ + run CLI under Node
bun run compat:node:mcp --build      # node --check on MCP entry
bun run compat:node:runtime          # build dist + run CLI + MCP probes
```

`release:preflight` runs `compat:node` as a non-blocking step on every
preflight. Pass `bun run release:preflight --with-node-compat` to add the
runtime probes (still non-blocking, since they require a clean dist
build).

The script writes a JSON report when `--json` or `--ci` is set:

```jsonc
{
  "bunUsage":     [{ "file": "packages/cli/src/foo.ts", "line": 12, "snippet": "Bun.file(..)" }],
  "blockers":     [...],
  "runtimeProbes": [{ "command": "node packages/cli/dist/main.js version", "exitCode": 0, "passed": true }],
  "passed":        true,
  "notes":         []
}
```

`Bun.*` usage in production source counts as a blocker for the pure-Node
runtime. Test files (`__tests__`) are skipped — those are Bun-only.

## Building the dist

`bun run build:dist` produces `packages/<name>/dist/` for every package.
This is what `npm install <pack>` consumes when an adopter runs under
Node.

## Where Bun is allowed

- Local dev scripts under `scripts/*` (we use `bun run` to invoke them).
- Tests under `packages/**/__tests__/` (we use `bun test`).
- Local fixtures used by tests.

Everything under `packages/*/src/` should avoid `Bun.*` so that the
compiled `dist/` is Node-compatible.

## Reporting blockers

If the audit reports `Bun.*` usage in production source, the recommended
mitigations are:

1. Replace the API with the Node equivalent (`node:fs`, `node:url`, etc.).
2. Isolate the call behind a tiny adapter in `@shrkcrft/shared` that
   detects the runtime.

Do not remove Bun as the primary dev tool — it stays the recommended
runtime for the monorepo.

## Runtime doctor (R11)

```bash
shrk runtime doctor
shrk runtime doctor --json
```

Reports current Bun / Node version, platform / arch, and the most
recent `compat:node` report (if present). Use this in CI to surface
"is the published dist Node-runnable?" without running the full audit
each time.
