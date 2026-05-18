# Roadmap

## v0.1 (this release)

- Bun-native workspace with 15 packages.
- Structured knowledge model + index + search + validation (duplicate / invalid id / missing-field warnings).
- Token-budgeted context builder.
- Rules, paths, templates services.
- Plan-first generator (dry-run by default) with `safeResolveTargetPath`.
- Saved-plan format (`sharkcraft.plan/v1`) + `shrk apply <plan.json>`.
- CLI: init / inspect / doctor / knowledge / rules / paths / templates / context / gen / apply / ask / mcp / version, with global `--cwd`.
- MCP server built on `@modelcontextprotocol/sdk` (25 tools + resources/list + resources/read, stdio transport).
- Target-root resolution for MCP via `projectRoot` option, `--cwd`, or `SHARKCRAFT_PROJECT_ROOT` env.
- Claude HTTP adapter + Claude CLI adapter.
- Examples: `generic-typescript-app`, `dogfood-target`, `angular-style-app`, `react-style-app`.
- Dogfood adopter setup (44 entries / 6 templates / 0 warnings) without modifying adopter source.
- Publish-ready package metadata + `scripts/build-dist.ts` (topo-sorted tsc emit) + `scripts/publish-dry-run.ts` (npm-pack smoke test).
- 100+ Bun unit / integration tests across 15 files.

## v0.2 (next)

- Replace the approximate token estimator with a real tokenizer.
- Expose the SDK's `StreamableHTTPServerTransport` via `shrk mcp serve --http`.
- Richer Nx integration (workspace.json detection, project-by-project knowledge).
- Plugin manifest discovery: load community packages exposing additional knowledge/templates.
- Streaming generator output for very large templates.
- MCP resource subscriptions for live knowledge updates.

## Later

- Live Claude CLI adapter parity with the HTTP provider.
- VS Code extension built on the MCP server.
- Self-hosted knowledge sync (multi-repo orgs).
- Editing UI for `sharkcraft/` files.
