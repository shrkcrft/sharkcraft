# Profiles

A *profile* in SharkCraft is a typed, named description of a project
concern. Two kinds exist:

- `workspace` — **builtin** (round 12). The engine's `WorkspaceProfile`
  vocabulary from `@shrkcrft/workspace` (`has-typescript`, `is-library`,
  `is-monorepo`, …): the ids every applicability filter names —
  `IPreset.appliesTo`, a convention's `appliesTo.profileIds`, a registration
  hint's `discovery.profileIds`, a template's `metadata.requiredProfileIds`.
  Every id is listed; `detected` says whether THIS repo exhibits it (with the
  detector's evidence). The self-config doctor resolves those `profileIds`
  against this kind (reference kind `workspace-profile`), so a real profile
  passes and a typo is a `*-profile-missing` finding with a did-you-mean.
- `migration` — describes a multi-phase migration gate (files / env vars to
  probe). Drives migration-readiness probing for the profile. Declared by a
  pack (`migrationProfileFiles`) or locally in `sharkcraft/migration-profiles.ts`
  (or `sharkcraft/migration-profiles/index.ts`). A routing hint's
  `recommends.profiles` names these ids.

Future kinds (reserved): `command-behavior`, `generator`, `boundary`,
`naming`, `architecture`, `language`, `report`.

## CLI

```bash
shrk profiles list                         # all kinds (never empty: the builtin workspace kind)
shrk profiles list --kind workspace        # the WorkspaceProfile vocabulary, `detected` marked
shrk profiles list --kind migration
shrk profiles get <id> [--kind <kind>]     # an unknown id gets a did-you-mean (exit 2)
shrk profiles doctor                       # registry-wide load issues
shrk profiles search <query> [--kind <kind>]
```

`--kind` is a closed set (`workspace`, `migration`): an unknown or valueless
kind is a usage error naming the known kinds (exit 2 — `profiles` is not a
verdict verb), never a silently dropped filter. An empty kind prints how that
kind is declared, rendered from the one declaration table
(`REFERENCE_KIND_DECLARATIONS`) — e.g. `(none — migration profiles are
declared via: pack key migrationProfileFiles · sharkcraft/migration-profiles.ts
· sharkcraft/migration-profiles/index.ts)`.

## MCP (read-only)

- `list_profiles` — `{ kind? }`, `kind` ∈ `workspace | migration` (enum in the
  inputSchema AND the strict wire validator; an unknown kind is rejected)
- `get_profile` — `{ id, kind? }`, same `kind` enum
- `get_profiles_doctor` — no args

## Adding a new profile kind

1. Add the typed interface to `packages/plugin-api/src/<kind>-profile.ts`.
2. Add a pack manifest slot (e.g. `commandBehaviorProfileFiles?`).
3. Add a loader in `packages/inspector/src/<kind>-profile-registry.ts`.
4. Extend `profile-registry.ts` (`ProfileKind`, and its
   `PROFILE_KIND_REFERENCE_KIND` row — a compile error until you do) to
   surface the new kind under the generic `shrk profiles` commands.
5. If its ids are referenceable, add a reference kind AND its
   `REFERENCE_KIND_DECLARATIONS` row (see [doc-references.md](doc-references.md#declarability-round-12)).
6. Add a doc and a fixture-based test.

## Source attribution

Each profile entry records:

- `source`: `builtin | local | pack | fixture`
- `packageName`: the contributing pack (when `source === 'pack'`)
- `sourceFile`: the relative path inside the pack or workspace
- `detected` (workspace entries only): whether this repo exhibits the profile

## Schemas

- `sharkcraft.profile-registry/v1`
- `sharkcraft.migration-profile-registry/v1`
