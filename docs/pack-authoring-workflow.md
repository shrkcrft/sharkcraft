# Pack authoring workflow (R44)

`shrk pack-author <verb>` (alias: `shrk pack author <verb>`) gives
pack contributors a single, preview-first surface for evolving pack
asset contributions and seeing what's pending across the authoring
loop.

## Verbs

```bash
shrk pack-author status              # inventory of pack contributions + drafts + signature state
shrk pack-author preview --kind <k> --id <id>
shrk pack-author pending             # cross-section pending view
shrk pack-author validate            # recommended post-authoring command list
shrk packs pending                   # alias for `pack-author pending`
```

## R44 scope

R44 implements the **knowledge** authoring slice end-to-end. The
remaining kinds (search-tuning, feedback-rule, agent-test, convention,
task-routing-hint, registration-hint, scaffold-pattern) are recognised
by the workflow but their preview verb returns an honest deferral with
the right next commands. This is the smaller subset that Part 3 of the
R44 brief explicitly permits.

| Kind | R44 preview support |
| --- | --- |
| `knowledge` | **implemented** — delegates to `shrk knowledge add/update/remove` |
| `search-tuning` | deferred — edit pack `assets/search-tuning.ts` directly for now |
| `feedback-rule` | deferred |
| `agent-test` | deferred |
| `convention` | deferred |
| `task-routing-hint` | deferred |
| `registration-hint` | deferred |
| `scaffold-pattern` | deferred |

The status report makes each kind's support level visible
(`authoring: preview` vs `authoring: deferred`) so an agent knows
before invoking which kinds round-trip cleanly.

## `pack-author status`

Reports, per kind:

- contribution count (local + every discovered pack),
- resolved local + pack target paths (with existence),
- whether the asset-provenance ledger exists,
- whether `SHARKCRAFT_PACK_SECRET` is present,
- pending drafts under `.sharkcraft/authoring/`,
- next commands.

Schema: `sharkcraft.pack-author-status/v1`.

## `pack-author preview`

```bash
shrk pack-author preview --kind knowledge --id team.style --reason "..."
```

For `knowledge`, the verb returns `implemented: true` and prints the
list of follow-up commands the caller should run. The actual draft
generation lives under `shrk knowledge add` (which `pack-author
preview` calls into).

For deferred kinds, the verb returns `implemented: false` with a
`deferralNote` plus a next-command list pointing at
`shrk packs contributions --kind <kind>` so the contributor can locate
the right file to hand-edit.

Schema: `sharkcraft.pack-author-preview/v1`.

## `pack-author pending`

The combined pending view — see `docs/pack-signatures.md` for the full
breakdown. Schema: `sharkcraft.pack-pending/v1`.

## `pack-author validate`

Prints (does NOT execute) the recommended post-authoring command list:

```
shrk knowledge stale-check --ci
shrk self-config doctor
shrk packs signature-status
shrk packs doctor --signature-explain
shrk packs sign --if-needed
```

Schema: `sharkcraft.pack-author-validate/v1`.

## Hard rules

- No new MCP write tools.
- No source mutation of `sharkcraft/<kind>.ts` or pack `assets/<kind>.ts`
  by any of these verbs.
- Drafts only land under `.sharkcraft/authoring/`. Lint fixes only land
  under `.sharkcraft/fixes/`.
- `pack-author pending` never signs anything. When the secret is
  missing it surfaces the exact command for a human / signing CI.

## When to use which command

| Question | Command |
| --- | --- |
| What kinds does this pack contribute to? | `shrk pack-author status` |
| What's left to finalise in this pack right now? | `shrk pack-author pending` |
| Want a knowledge entry added/updated/removed? | `shrk knowledge add/update/remove` (or `shrk pack-author preview --kind knowledge --id <id>` for the dispatcher) |
| Want lint pass over the knowledge corpus? | `shrk knowledge lint --fix-preview --write-preview` |
| Where do I see who/why authored a given asset? | `shrk provenance show <assetId>` |
| Want the recommended validation list? | `shrk pack-author validate` |
