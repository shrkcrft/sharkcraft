# Surface profile at `shrk init` (R58)

`shrk init` detects the workspace shape and writes `surface.profile`
into the generated `sharkcraft.config.ts` so projects start with a
sensible default tier model instead of the empty fallback.

## Built-in profiles

| Profile | When it fits |
|---------|--------------|
| `developer` | Default; full common verb set. |
| `small-app` | Single-package TS/JS app (Next, Nest, Bun service). |
| `monorepo` | nx / turborepo / pnpm workspaces. |
| `pack-author` | Repos that publish a SharkCraft pack. |
| `ci` | CI-only invocations (read-only, JSON-first). |
| `agent` | Agent-driven sessions (compact catalog). |

## Detection

Without `--surface-profile`, init runs the workspace detector and
calls `suggestSurfaceProfile(workspaceProfiles)`. The mapping is:

- `pack-author` / `sharkcraft-pack` → `pack-author`
- `nx` / `turborepo` / `pnpm-workspace` / `monorepo` → `monorepo`
- `single-package` / `app` / `next` / `nest` → `small-app`
- `ci-only` / `headless` → `ci`
- otherwise → `developer`

The generated config keeps a comment naming the heuristic that fired,
so the choice is auditable.

## Override

```bash
shrk init --surface-profile monorepo --write
```

`--surface-profile` accepts any built-in profile id. Unknown ids exit 2
with a clear error.

## Drift advisory

`shrk doctor` adds a `surface-profile-drift` advisory check when the
configured profile no longer matches what the workspace shape
suggests. Example: config says `small-app` but the repo grew into a
monorepo. The advisory is folded into the doctor summary by default
(R49); pass `--show-advisory` for the full inline view.

The fix suggestion is:

```bash
shrk init --surface-profile <detected> --write
```

This is intentionally a re-run of `init` rather than an in-place
patch — `init` is the source of truth for surface profile selection.
