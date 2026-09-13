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
2. The spine pipelines — every command they reference is core. Today that
   is `engine.feature-dev`, joined by
   `engine.safe-generation` when it exists. <!-- ref-allow: not registered yet -->
3. A `surface.disabled` selector (round 11) → `experimental`, source
   `disabled`. Never a bootstrap command or one of its subverbs (a deny of
   `surface *` cannot lock you out of `surface allow`); a core command a
   selector names stays callable with a `cannot-disable-core` warning.
4. A **tool-maintenance** command (catalog audience `tool-maintenance`)
   outside SharkCraft's own repository → `experimental`, source
   `tool-maintenance` — see [Tool-maintenance commands](#tool-maintenance-commands-round-11).
5. Pack-contributed CLI commands → default to `experimental`. Pack
   manifests can declare commands; the consumer opts in.
6. Catalog entries with explicit `tier: CommandTier.Experimental` →
   experimental.
7. Catalog entries with `showInDefaultHelp: false` and no other
   classification → experimental.
8. Everything else → `extended`.

## Tool-maintenance commands (round 11)

Some commands maintain **SharkCraft itself**: they check the tool's own
documentation set, examples tree, release artifacts, command catalog or round
snapshots. In a consumer repository they used to run and FAIL — `docs check`
demanded SharkCraft's docs, `release readiness` its release notes — a red
result on a healthy repo.

The catalog tags them with the audience `tool-maintenance`:

`docs check` · `examples check` · `self audit` · `install smoke` ·
`release readiness` · `release smoke` · `commands doctor` · `commands ux-check`
· `commands overlaps` · `commands legacy` · `commands machine` ·
`rounds capture|list|show` · `diff rounds` (flag variants included).
Consumer-useful verbs are deliberately NOT tagged: `docs references`,
`packs release-check`, `packs sign`, `schemas`, `changelog`.

**One host authority.** `detectSharkcraftRepo` (`@shrkcrft/inspector`) decides
whether the project root is SharkCraft's own repository:
`packages/cli/package.json` named `@shrkcrft/cli`, plus the root package named
`sharkcraft` or the sibling `packages/inspector` + `packages/mcp-server`
(directory markers alone misfire on any consumer monorepo). `self audit`,
`install smoke`, the MCP self-audit tool and the tier resolver all read it.

Outside the tool repo a tool-maintenance command:

- is hidden from `--help` / `--full-help` and listed in `surface list`'s
  experimental bucket with the `gated` and `tool-maintenance` flags;
- exits **78** through the surface gate when invoked — never 1 or 2:

  ```
  `docs check` maintains SharkCraft itself and does not apply to this repository — this is not a check failure.

  To run it anyway:
    $ shrk surface enable "docs check" --write
  ```

- is refused by the MCP gate too: `get_docs_check`, `get_examples_check`,
  `get_release_readiness` and `get_self_audit` declare `cliCommand`.

`surface.enabled` is the escape hatch (`shrk surface enable "docs check"
--write`). Inside SharkCraft's repository every command stays callable.

## `surface list` is the command index (round 11)

`shrk surface list` enumerates the COMMAND INDEX — every registered handler
path, plus the subverbs a handler declares or the catalog documents under a
real handler, and the meta flags (`--about`, `--help`, `--full-help`,
`--version`) — not the catalog. Before round 11 it listed catalog rows only: 75
registered verbs were missing, 55 flag-variant rows were presented as separate
commands, and every extended row printed the same placeholder sentence.

It lists the subverbs a handler DECLARES (`subverbs`) or the catalog documents
under a real handler; a subverb a handler dispatches from `positional[0]`
without declaring it is absent from the index. For a tail under such a handler,
the command-string resolver reports `prefix-only` (counted, never flagged)
rather than guessing, but only when the handler declares no `positionals`. A
tail under a handler with a free positional resolves `ok` (`graph <assetId>`:
`shrk graph zzz` is a lookup, not an unknown subverb). Each handler that
declares its subverbs closes the gap for its verb: the graph code-intelligence
subverbs and `api-diff capture` are declared, so they are listed.

Text columns: `command | description (first sentence) | audience | flags`
(`hidden`, `enabled`, `disabled`, `gated`, `uncatalogued`, `tool-maintenance`,
`pack:<name>`). The audience column answers "is this for me?" next to "does
this exist?". The header adds a `host` line (SharkCraft's own repository or
not). The tier `detail` lives in `surface explain` and `--json` (which also
carries `isToolRepo`, and per row `disabled` / `deniedBy`).

`--json` is schema `sharkcraft.surface.v2` — the machine-readable command
index (every registered path plus catalog-documented or declared subverbs). Each row adds `description`, `usage?`, `dispatch`
(`trie` / `subverb` / `meta`), `catalogued`, `audience` and `variants` to the v1
fields; `totals` adds `uncatalogued`; the summary adds `registryBacked`
(`false` only for a registry-less engine call, whose rows are the catalog
relabelled — a partial inventory, and labelled `PARTIAL` in text).

A registered command with no catalog row resolves `extended` with source
`uncatalogued`. In SharkCraft's own repository `shrk commands doctor` warns
`registry-path-not-in-catalog`, and `surface explain` names it as the remedy.
Elsewhere `commands doctor` is tool-maintenance (exit `78`), so `surface
explain` calls the row a SharkCraft catalog gap — informational, nothing the
repository can fix.
`surface explain <command…>` accepts a multi-word path and renders a
default-tier row's reason from its source.

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
    // Round 11 — the deny list: NOT callable here (the surface gate exits
    // 78) and never in `--help`.
    disabled: ['reposet *'],
  },
});
```

**Selectors.** Every `enabled` / `hidden` / `disabled` entry is an exact
command path (or alias spelling), or a **group selector** `'<path> *'` that
names the path and every command below it (`'bundle *'` → `bundle`,
`bundle list`, `bundle replay …`). ONE matcher (`surface/surface-selector.ts`)
serves the tier resolver, the summary and `surface deny`. A selector that
names nothing is reported as `unknown-command` — never silently ignored.

**`--help` honours the block.** `--full-help` and the start screen render the
surface summary, so `surface explain <cmd>` → `visible-in-help` and the actual
help output always agree: `hidden`, a profile's `hidden`, `disabled` and the
tool-maintenance gate all reach `--help`. `--full-help --all` lists every
command annotated `(hidden)` / `(gated: …)`.

**Layering.** A profile's lists merge with the config's. An explicit config
`enabled` entry overrides a PROFILE's deny (config wins over the profile);
a config `disabled` entry wins over a config `enabled` one (warning
`enable-disable-conflict`).

Core commands can never appear in `hidden[]`, `enabled[]` or `disabled[]`
(hiding is a refusal, enabling a no-op, disabling a `cannot-disable-core`
warning — the resolver warns about each).

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

Disable a command or a whole group in this repository (round 11), and undo it:

```bash
shrk surface deny 'bundle *'            # preview: lists what it denies
shrk surface deny 'bundle *' --write    # writes surface.disabled
shrk surface allow 'bundle *' --write   # removes the selector again
```

`deny` refuses (exit 2) a selector that names no command or only core
commands. Every mutation edits the config's OWN `surface{}` block and keeps
its `profile` (it no longer copies the profile's lists into the config).

Reset everything (`enabled`, `hidden` and `disabled`):

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

The JSON form — printed on stdout instead of the text when the caller passed
`--json` (or `--format json`), with stderr empty — is schema
`sharkcraft.surface.not-enabled.v1`:

```json
{
  "schema": "sharkcraft.surface.not-enabled.v1",
  "command": "<name>",
  "tier": "experimental",
  "reasonCode": "experimental | tool-maintenance | disabled",
  "reason": "<human-readable>",
  "enableCommand": "shrk surface enable <name>",
  "explainCommand": "shrk surface explain <name>"
}
```

`reasonCode` (round 11) names the cause; the text and the remedy follow it:
`tool-maintenance` → "`<name>` maintains SharkCraft itself and does not apply
to this repository — this is not a check failure", remedy `shrk surface enable
"<name>" --write`; `disabled` → "`<name>` is disabled in this repository by
surface.disabled ('<selector>')", remedy `shrk surface allow "<selector>"
--write` (or `shrk surface enable "<name>" --write` over a profile's deny).

Agents must distinguish this from "unknown command" (which exits
with code 2 via the did-you-mean path).

## MCP gating

The MCP server applies the same gate. When the host wires the
gate resolver (CLI does this automatically), an experimental MCP
tool returns an `isError: true` tool response with the same schema.
Bootstrap MCP tools (no `cliCommand` field — e.g.
`get_command_catalog`, `inspect_workspace`) always remain callable.
The MCP gate reads the same summary as the CLI gate, so a tool whose sibling
is a tool-maintenance command (`get_docs_check`, `get_examples_check`,
`get_release_readiness`, `get_self_audit`, `get_release_smoke_report`,
`get_install_smoke_report`) or a command `surface.disabled` denies is refused
with the CLI's reason and remedy. Every tool-maintenance catalog row that is
`mcpAvailable` names at least one such gated tool (a lock enforces it).

A restart is required to pick up surface config changes in MCP
mode (R57+ may add hot-reload).

## Project shape

`shrk init` (and `shrk doctor`) detect the project shape
(`single-app`, `app-with-libs`, `monorepo`, `library`, `unknown`)
and seed `surface.hidden[]` defaults accordingly. See
[project-shape.md](./project-shape.md).
