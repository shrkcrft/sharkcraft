# Zero-config init

SharkCraft's adoption floor: get useful output on a brand-new TS repo
without hand-writing any config.

## The 60-second flow

```bash
# 1. See what SharkCraft detects about your project. No writes.
shrk inspect

# 2. Preview what a zero-config init would do. Still no writes.
shrk init --zero-config

# 3. Actually write the inferred preset.
shrk init --zero-config --write
```

That's it. Three commands, all dry-run-first.

## What `shrk inspect` reports (R47)

The Detected block:

```
=== Detected ===
  workspace flavor     single package | Nx workspace | Turborepo workspace | npm/pnpm/yarn workspaces | monorepo
  package manager      npm | pnpm | yarn | bun | unknown
  frameworks           <comma list>
  typescript           yes | no
  source roots         src, lib, app  (any present)
  test roots           tests, test, __tests__, spec, specs  (any present)
  package roots        packages, libs, apps  (when applicable)
  generated dirs       dist, build, out, coverage, .next, .turbo  (any present)
  scripts              build=<name> test=<name> typecheck=<name> lint=<name> start=<name>
  configs              tsconfig, eslint, biome, github-actions, nx.json, turbo.json  (any present)
  recommended preset   <id> (<confidence>)
  not guessed:
    • source roots (if none detected)
    • test roots (if none detected)
    • lint config (if no ESLint and no Biome)
    • tsconfig.json (if no TypeScript config)
```

The **not-guessed** lines are intentional: SharkCraft would rather
say "I could not detect this" than guess wrong.

## What `shrk init --zero-config` does

1. Inspects the workspace via `inspectWorkspace()`.
2. Ranks every preset against the detected profiles using
   `recommendPresets()`. The recommender adds +5 per matched
   `appliesTo` profile and (R47) subtracts 3 per missing one, so a
   more-specific preset (`next-app`: needs `[HasNext, HasReact,
   IsFrontend]`) does not outrank a more-targeted one (`react-app`:
   needs `[HasReact, IsFrontend]`) on a React-only repo.
3. Picks the top-ranked preset.
4. Prints the picked id + the matching reasons + the Detected block.
5. **Defaults to dry-run.** Pass `--write` to persist.

## Behaviour table

| Flag combination | Mode | Behaviour |
|---|---|---|
| `shrk init --zero-config` | dry-run | preview only |
| `shrk init --zero-config --write` | write | persist the inferred preset |
| `shrk init --preset auto` | dry-run | alias of `--zero-config` |
| `shrk init --preset <id> --dry-run` | dry-run | preview a named preset |
| `shrk init --preset <id> --write` | write | persist a named preset |
| `shrk init --suggest-only` | none | print ranked recommendations only |
| `shrk init --legacy` | write | full pre-R26 seed |

## The `--no-config` companion commands

When your repo has *no* `sharkcraft/` folder yet:

- `shrk inspect` — works. Surfaces the Detected block and ends with
  "No sharkcraft/ folder yet — try `shrk init --zero-config`".
- `shrk inspect --no-config` — same as above but suppresses the
  warning about the missing folder.
- `shrk doctor --no-config` — exit code stays 0; the verdict is
  advisory ("`--no-config` mode — repo has no sharkcraft/ yet").
- `shrk recommend "<task>"` — works without any sharkcraft config.

These four commands together are the adoption floor: a user with a
brand-new repo can use them to evaluate SharkCraft without committing
to anything.

## Detection details

| Signal | How it's detected |
|---|---|
| Package manager | `bun.lock` / `pnpm-lock.yaml` / `yarn.lock` / `package-lock.json` |
| Nx workspace | `nx.json` present or `nx` / `@nx/workspace` dependency |
| Turborepo | `turbo.json` present or `turbo` dependency |
| Package workspaces | `workspaces` array in `package.json` |
| Frameworks | dependency name + file marker (e.g. `next` + `next.config.js`) |
| TypeScript | `tsconfig.json` / `tsconfig.base.json` |
| ESLint | `.eslintrc*` / `eslint.config.*` / dependency |
| Biome | `biome.json` / dependency |
| GitHub Actions | `.github/workflows/` directory |
| Source roots | `src/`, `lib/`, `app/`, `source/` |
| Test roots | `tests/`, `test/`, `__tests__/`, `spec/`, `specs/` |
| Package roots | `packages/`, `libs/`, `apps/` |
| Generated dirs | `dist/`, `build/`, `out/`, `coverage/`, `.next/`, `.turbo/` |

The detector never executes a project script. It only reads files.

## What it does **not** guess

- Build / test / typecheck / lint command **bodies**. The Detected
  block reports the script *name* (`build`, `test`, …) but leaves the
  command unchanged. A SharkCraft pipeline that wants to run them
  invokes `npm run <name>` (or `bun run <name>`).
- Cross-layer architecture. SharkCraft will pick a preset that ships
  boundary rules, but the rules themselves are not auto-derived from
  source. They live in `sharkcraft/boundaries.ts` after `init`.
- Knowledge entries. The preset seeds zero knowledge by default; you
  add knowledge with `shrk knowledge add` or by editing
  `sharkcraft/knowledge.ts`.

## Next steps after init

```bash
shrk doctor                            # validate setup
shrk context --task "<one-sentence>"   # what context applies to this task
shrk ci scaffold github-actions --quickstart   # CI in one flag
```

For TS/JS-specific preset details see [`presets.md`](presets.md). For
the ESLint / Biome integration story see
[`eslint-bridge.md`](eslint-bridge.md) and
[`biome-bridge.md`](biome-bridge.md).
