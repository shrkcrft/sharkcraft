# Public alpha checklist

Run every entry below before tagging `0.1.0-alpha.2`.

## Build + tests

- [ ] `bun x tsc -p tsconfig.base.json --noEmit`
- [ ] `bun test`
- [ ] `bun run build:dist`
- [ ] `bun run release:preflight`

## Safety

- [ ] `shrk commands doctor` → 0 errors / 0 warnings.
- [ ] `shrk commands ux-check` → 0 errors.
- [ ] `shrk safety audit` → no error findings.
- [ ] MCP exposes 0 writable tools (read-only by contract — see `docs/mcp.md`).

## Surfaces

- [ ] `shrk doctor` → Ready ✓.
- [ ] `shrk release readiness --strict` → READY ✓ / 0 blockers.
- [ ] `shrk release smoke --scenario all --assertions` → PASS.
- [ ] `shrk release smoke --matrix --target sharkcraft,dogfood,synthetic`
      → PASS.
- [ ] `shrk install smoke --tarball` → PASS.
- [ ] Dogfood scenarios green — run the integration scripts under
      `examples/dogfood-target/` (the `shrk demo` namespace was retired).

## Docs

- [ ] `docs/releases/0.1.0-alpha.2.md` exists.
- [ ] `docs/public-alpha-limitations.md` exists.
- [ ] `docs/external-repo-quickstart.md` exists.
- [ ] `CHANGELOG.md` is updated.
- [ ] `README.md` references the release notes.

## Final review

- [ ] Verify no Bun-only APIs in `dist/` via `bun run compat:node`.
- [ ] Verify the smoke matrix run is captured in
      `.sharkcraft/reports/release-smoke-matrix.json`.
- [ ] Verify the readiness HTML is captured in
      `.sharkcraft/reports/release-readiness.html`.
