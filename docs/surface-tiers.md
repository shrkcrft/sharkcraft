# Surface tiers — adaptive command visibility

> R56+. See `.sharkcraft/reports/r56-surface-audit.md` for the audit
> that drives the defaults.

SharkCraft exposes a large command catalog — 300+ verbs across CLI
groups. Not every project needs all of them. The **surface tier**
model lets each repo see the slice it actually uses without forking
the engine.

Three tiers, all derived mechanically (no human-curated lists):

| Tier | Visible in `--help`? | Callable? | Where it comes from |
| --- | :-: | :-: | --- |
| `core` | ✓ always | ✓ always | Bootstrap set ∪ spine pipeline references |
| `extended` | ✓ unless hidden | ✓ always | Default for the bulk of catalog entries |
| `experimental` | ✗ never | ✗ until enabled | Pack-contributed commands + explicit overrides |

The tier of any given command is computed at runtime from:

1. The static bootstrap set (`init`, `doctor`, `recommend`, `surface`,
   `help`, `version`, `commands`, `start-here`, `--about`). Bootstrap
   commands are core regardless of any other rule.
2. The spine pipelines (`engine.feature-dev`, `engine.safe-generation`
   when it exists) — every command they reference is core.
3. Pack-contributed CLI commands → default to `experimental`. Pack
   manifests can declare commands; the consumer opts in.
4. Catalog entries with explicit `tier: CommandTier.Experimental` →
   experimental.
5. Catalog entries with `showInDefaultHelp: false` and no other
   classification → experimental.
6. Everything else → `extended`.

## The `surface{}` config block

In `sharkcraft.config.ts`:

```ts
import { defineSharkCraftConfig } from '@shrkcrft/config';

export default defineSharkCraftConfig({
  surface: {
    // Promote experimental commands to callable (and visible in
    // `surface list`; `--help` visibility still respects the catalog
    // surface classification).
    enabled: ['some-pack-cmd'],
    // Hide extended commands from `--help` (they remain callable).
    // Used to slim the default surface on small-app repos.
    hidden: ['bundle apply-assist', 'reposet init'],
  },
});
```

Core commands can never appear in `hidden[]` or `enabled[]` (the
former would be a refusal; the latter is a no-op the resolver
warns about).

## Workflow

Inspect what's available:

```bash
shrk surface list             # tiered text view
shrk surface list --json      # machine-readable
shrk surface explain doctor   # why this command has its tier
```

Opt into an experimental command:

```bash
shrk surface enable my-pack-cmd            # preview the diff
shrk surface enable my-pack-cmd --write    # actually edit sharkcraft.config.ts
```

Hide an extended command (e.g. monorepo-only verbs on a single-app
repo):

```bash
shrk surface hide bundle apply-assist --write
shrk surface unhide bundle apply-assist --write
```

Reset everything:

```bash
shrk surface reset --write
```

## Structured "not enabled" error

When a user / agent runs an experimental command that isn't enabled,
the CLI exits with code **78** and emits:

```
Command `<name>` exists but is not enabled in this repo.

It is tier=experimental. <detail>

Enable it:
  $ shrk surface enable <name>

Or see why it is gated:
  $ shrk surface explain <name>
```

The schema for the JSON form (when the caller passed `--json`) is
`sharkcraft.surface.not-enabled.v1`:

```json
{
  "schema": "sharkcraft.surface.not-enabled.v1",
  "command": "<name>",
  "tier": "experimental",
  "reason": "<human-readable>",
  "enableCommand": "shrk surface enable <name>",
  "explainCommand": "shrk surface explain <name>"
}
```

Agents must distinguish this from "unknown command" (which exits
with code 2 via the did-you-mean path).

## MCP gating

The MCP server applies the same gate. When the host wires the
gate resolver (CLI does this automatically), an experimental MCP
tool returns an `isError: true` tool response with the same schema.
Bootstrap MCP tools (no `cliCommand` field — e.g.
`get_command_catalog`, `inspect_workspace`) always remain callable.

A restart is required to pick up surface config changes in MCP
mode (R57+ may add hot-reload).

## Project shape

`shrk init` (and `shrk doctor`) detect the project shape
(`single-app`, `app-with-libs`, `monorepo`, `library`, `unknown`)
and seed `surface.hidden[]` defaults accordingly. See
[project-shape.md](./project-shape.md).
