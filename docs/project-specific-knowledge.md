# Project-specific knowledge belongs in packs, not in the engine (R32)

SharkCraft is a generic, project-agnostic, deterministic developer-
intelligence platform. The engine packages under `packages/` must not
bake in any specific project's knowledge — folder layout, plugin names,
contract templates, migration profiles, etc. Those live in packs.

## Why

A SharkCraft fork that embeds project-specific paths is hard to reuse for
another project. Worse, every release ships those paths to every
consumer. A clean platform/pack split lets:

- Multiple adopters (hypothetical Acme, Globex, etc.) coexist without
  collisions.
- Adopters re-sign and version their pack independently of the engine.
- New users see a small, generic engine + extension points, not a
  project-shaped engine they have to strip-mine.

## Acceptance rules

The engine grep gate:

```bash
rg "<project-token>|FEATURE_KEYS" packages/inspector packages/cli packages/mcp-server
```

returns **no hits** except in tests/fixtures explicitly marked as such.

Generalised acceptance: run the project-coupling audit with whatever
deny tokens make sense for your project:

```bash
shrk migrate project-coupling audit \
  --token <project-token> --token <project-paths> --token FEATURE_KEYS \
  --token <your-project-id>
```

The verdict should be `clean` for engine packages.

## What "project-specific" means

- A literal folder path tied to one project (`packages/<project>/...`).
- A constant tied to one project (`FEATURE_KEYS`).
- An id namespaced under a project (`<project>.plugin-contract`).
- A heuristic that only makes sense for one project's vocabulary
  (`primitive`, `adapter`, `sandbox` as hardcoded ranker boosts).
- A demo / agent-test / contract template that exists only to exercise a
  single project's behavior.

If any of these appear in `packages/`, it should move to:

- A pack contribution (e.g. `pluginLifecycleProfileFiles`,
  `contractTemplateFiles`, `searchTuningFiles`, …).
- A pack-shipped agent-test / context-test.
- A fixture clearly marked as a test fixture.

## What stays in the engine

- Generic plumbing: registries, loaders, CLI surfaces, MCP tools.
- Generic taxonomies (rule priorities, contract modes, scaffold axes).
- Generic safety contracts (`apply --verify-signature`, MCP read-only).
- Generic templates with neutral names (`acme.*`, `<scope>.*`).

## Migrating an existing fork

See `docs/extension-platform.md`. The `shrk migrate project-coupling`
helpers tell you exactly which files need extracting.
