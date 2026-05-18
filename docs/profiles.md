# Profiles (R32)

A *profile* in SharkCraft is a typed, named description of a
project-specific concern (plugin layout, migration gate, naming
convention, …). The engine ships zero built-in profiles; every profile
comes from a pack contribution or local `sharkcraft/` config.

## Kinds (R32)

- `plugin-lifecycle` — describes where plugins live, the key-table, and
  barrels. Drives `shrk plugin rename|remove`.
- `migration` — describes a multi-phase migration gate (files / env vars
  to probe). Drives `shrk migration readiness`.

Future kinds (reserved): `command-behavior`, `generator`, `boundary`,
`naming`, `architecture`, `language`, `report`.

## CLI

```bash
shrk profiles list                         # all kinds
shrk profiles list --kind plugin-lifecycle
shrk profiles get <id> [--kind <kind>]
shrk profiles doctor                       # registry-wide load issues
shrk profiles search <query> [--kind <kind>]
```

## MCP (read-only)

- `list_profiles` — `{ kind? }`
- `get_profile` — `{ id, kind? }`
- `get_profiles_doctor` — no args

## Adding a new profile kind

1. Add the typed interface to `packages/plugin-api/src/<kind>-profile.ts`.
2. Add a pack manifest slot (e.g. `commandBehaviorProfileFiles?`).
3. Add a loader in `packages/inspector/src/<kind>-profile-registry.ts`
   (mirror `plugin-lifecycle-profile-registry.ts`).
4. Extend `profile-registry.ts` to surface the new kind under the
   generic `shrk profiles` commands.
5. Add a doc and a fixture-based test.

## Source attribution

Each profile entry records:

- `source`: `builtin | local | pack | fixture`
- `packageName`: the contributing pack (when `source === 'pack'`)
- `sourceFile`: the relative path inside the pack or workspace

## Schemas

- `sharkcraft.profile-registry/v1`
- `sharkcraft.plugin-lifecycle-profile-registry/v1`
- `sharkcraft.migration-profile-registry/v1`
