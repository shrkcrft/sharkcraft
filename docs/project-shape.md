# Project shape — auto-detection

> R56+. Drives the default surface composition.

`detectProjectShape()` (from `@shrkcrft/workspace`) classifies a
repo into one of five shapes. The classification is deterministic
and fast — no AI, no recursion beyond the project root and a few
known directories.

## Shapes

| Shape | When | Default surface bias |
| --- | --- | --- |
| `single-app` | One Angular project (or one dev-script app), no libs, no workspaces | Hides monorepo verbs (`bundle`, `reposet`, `packs new`, …) |
| `app-with-libs` | `apps/` + `libs/` directories, or Angular workspace with >1 project | Keeps the full default surface |
| `monorepo` | Nx with ≥6 projects, OR `package.json workspaces` with ≥3 entries, OR Nx + ≥6 packages on disk, OR workspaces + ≥3 packages | Full default surface; pack authoring kept callable |
| `library` | Only build/test scripts, no app dir, no packages | Hides app/runtime verbs (`dev start`, `dev report`, …) |
| `unknown` | Nothing strong enough to classify | Full default surface (conservative) |

## Signals (in priority order)

1. **`nx.json` + ≥6 projects** → Monorepo. Project count comes from
   `nx.json projects{}` (legacy) or `project.json` files under
   `apps/`, `libs/`, `packages/`.
2. **`package.json workspaces[]` with ≥3 entries** → Monorepo.
3. **`nx.json` + ≥6 entries in `packages/`** → Monorepo (catches
   workspaces that infer projects from disk).
4. **Workspaces field + ≥3 entries in `packages/`** → Monorepo.
5. **`angular.json` with 1 project** → SingleApp.
6. **`angular.json` with >1 project** → AppWithLibs.
7. **`apps/` + `libs/` on disk** → AppWithLibs.
8. **Only build/test/lint/format scripts + no apps/ + no packages/** →
   Library.
9. **A `dev` script + no libs/ + no nx.json + no workspaces + no
   packages/** → SingleApp.
10. Otherwise → Unknown.

The rule order is intentional: monorepo signals dominate, and
SingleApp is only claimed when every alternative shape is ruled out.
This avoids false-positives where a meta `dev` script triggers
SingleApp on a clearly-monorepo project (the SharkCraft repo itself
was the forcing test case).

## Cache

The detection writes to `.sharkcraft/shape.json` (added to the
default `.gitignore` set by R56). The cache is regenerated on
`shrk doctor` if the config file has changed.

```json
{
  "schema": "sharkcraft.shape.v1",
  "detection": {
    "shape": "monorepo",
    "evidence": ["nx.json present", "packages/ (22 entries)"],
    "signals": { ... }
  },
  "cachedAt": "2026-05-17T...Z"
}
```

## Doctor

`shrk doctor` prints one line:

```
  shape              monorepo (nx.json present)
  surface            14 core + 325 extended (0 hidden, 0 experimental enabled)
```

The JSON form exposes the full detection block + surface totals
under `shape: {...}` and `surface: {...}`.
