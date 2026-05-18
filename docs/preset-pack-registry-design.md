# Preset / pack registry — design (R45)

Status: **design only** — no implementation in R45.

## Today

- Presets ship as built-ins under `@shrkcrft/presets/builtin/*` (45
  presets in R45).
- Packs ship as separate packages with signed manifests, discovered by
  the `@shrkcrft/packs` discovery layer.
- There is no install command. Adding a third-party preset means adding
  a TypeScript dependency and re-exporting from the consumer's
  `sharkcraft/` folder.

## Goal

Allow the community to publish:

- **Presets** — additive bundles (rules / paths / templates / pipelines
  / docs) keyed by a stable id.
- **Packs** — full extensions (presets + verification commands + custom
  checks + contract templates).

…and let teams install them with one command, while preserving the
SharkCraft signing + safety guarantees.

## Naming + versioning

- Preset ids are slug-style (`<scope>/<id>`), e.g.
  `@acme/clean-arch-ts`.
- Pack ids are npm-package names, e.g. `@acme/sharkcraft-pack`.
- Both follow semver. A `sharkcraftRange` field on the manifest
  declares engine compatibility (e.g. `">=0.10 <0.12"`).

## Compatibility

- Preset / pack rejected at install time if `sharkcraftRange` excludes
  the local engine version.
- Pack signature must be valid (existing `@shrkcrft/packs` discovery
  rules apply).
- Preset / pack listing the same id as a built-in is rejected (no
  shadowing).

## Signing

- Packs are signed today via `shrk packs sign`. The signature is
  recorded in `dist/manifest.json` per pack. We do **not** trust an
  unsigned pack by default; `--allow-unsigned` is the explicit opt-in.
- Presets are typed data (not executable code). They do not need
  signing; their content is verified against the preset schema at load
  time.

## CLI surface (proposed)

```bash
shrk preset add <id>       # install a preset (npm install + register)
shrk preset remove <id>    # uninstall
shrk preset list --installed
shrk packs add <pkg>        # install a pack
shrk packs remove <pkg>
shrk packs update           # upgrade installed packs
shrk packs doctor           # verify installed packs (signature + compat)
```

All four commands are CLI-only (never MCP). All require `--allow-unsigned`
to install an unsigned pack.

## Deprecation

- Presets / packs can mark themselves `deprecated: true` in their
  manifest. `shrk presets list` / `shrk packs list` show a deprecation
  banner. `shrk presets doctor` / `shrk packs doctor` exit non-zero if
  any installed asset is deprecated.

## Trust model

- The default registry is **npm**. Packs ship as regular npm packages.
  This sidesteps the question "do we run our own registry?" by leaning
  on existing infrastructure.
- A small allow-list of "official" pack publishers (Anthropic /
  SharkCraft maintainers) is documented in `docs/security.md`. Anything
  outside the allow-list is third-party and the user accepts the risk
  explicitly when running `shrk packs add`.
- The signing model already pins the pack to its publisher's key
  fingerprint at install time. A pack signed by a different key on
  update fails `pack doctor`.

## Implementation scope (when this lands)

1. Extend the preset manifest with `sharkcraftRange`, `deprecated`,
   `publisher`.
2. Wire `shrk preset add <id>` → `bun add <pkg>` + register in the
   consumer's `sharkcraft/index.ts`.
3. Wire `shrk packs add <pkg>` → `bun add <pkg>` + signature verification.
4. `shrk packs update` runs `bun update` for the installed pack set and
   re-runs `pack doctor`.
5. Document the trust model in `docs/security.md`.

## Estimated complexity

~1 week of focused engineering. Not in scope for R45 — the audit confirms
the foundations are already in place (signing, manifests, discovery), so
the cost is mostly CLI wiring + tests + docs.
