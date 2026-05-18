# Rule authoring

SharkCraft is a rule-driven knowledge engine. Rules are
`IKnowledgeEntry` records with `type: 'rule'` that describe an
architectural or behavioural constraint. R43 added a deterministic
scaffold + a per-rule quality doctor so an agent can introduce a new
rule without guessing the schema.

## Quick start

```bash
shrk rules scaffold \
  --id architecture.no-reexport-proxy \
  --kind architecture \
  --rationale "Files whose body is purely re-exports hide the real source." \
  --owner platform
```

By default the command prints a preview to stdout — nothing is
written. Pass `--write-preview` to materialise three files under
`.sharkcraft/fixes/`:

- `rule-<id>.preview.ts` — a `defineRule` body you can copy into
  `sharkcraft/rules.ts` (or your pack's `rules.ts`).
- `rule-<id>.preview.json` — a machine-readable manifest of the same.
- `rule-<id>.preview.md` — an explainer with next commands.

`--write-preview` only writes under `.sharkcraft/fixes/`. The engine
never overwrites your existing rules file.

## Rule kinds

| Kind | Default tags | Default verification | Notes |
| --- | --- | --- | --- |
| `architecture` | `architecture, boundaries` | `shrk check boundaries` | Default kind. |
| `safety` | `safety` | `shrk safety audit --deep` | Critical priority by default. |
| `style` | `style` | `bun x tsc -p tsconfig.base.json --noEmit` | Examples are required by `shrk rules doctor`. |
| `governance` | `governance` | `shrk doctor`, `shrk safety audit --deep` | High priority. |
| `migration` | `migration` | `shrk migrate project-coupling audit --fail-on engine` | Medium priority. |
| `testing` | `testing` | `bun test` | High priority. |
| `advisory` | `advisory` | _(none)_ | Sets `metadata.advisory: true` so `shrk rules doctor` does not require `verificationCommands`. |

## Schema cheatsheet (what every rule should carry)

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | `<namespace>.<kebab-id>`, e.g. `architecture.no-reexport-proxy`. |
| `title` | yes | Short human title. |
| `priority` | yes | `critical | high | medium | low`. |
| `scope` | yes | Free-form, e.g. `['typescript', 'architecture']`. |
| `tags` | yes | Used by `shrk rules relevant` and `diagnoseActionHints`. |
| `appliesWhen` | yes | When the rule should be surfaced (`generate-code`, `review-code`, …). |
| `content` | yes | The rationale. Long enough for `shrk rules doctor` to not flag it as vague. |
| `examples` | recommended | Style/architecture rules are required to provide at least one. |
| `actionHints.forbiddenActions` | recommended | Surfaces in context output — what the agent must NOT do. |
| `actionHints.verificationCommands` | recommended | Reference commands listed in `sharkcraft.config.ts verificationCommands[]`, or use `shrk …` / `bun …` style strings. |
| `actionHints.writePolicy` | when write-related | `cli-only | none | mcp-allowed`. |
| `source.origin` | recommended | Owner / source for high/critical rules. |
| `metadata.advisory` | when advisory | Set `true` to opt out of the verification-required axis. |
| `metadata.checks` | when external check exists | Array of `ICustomCheckDescriptor` — see `docs/custom-checks.md`. |

## Validating the new rule

```bash
shrk rules doctor --id <ruleId>
shrk doctor
```

`shrk rules doctor` returns the new R43 codes:

| Code | Meaning |
| --- | --- |
| `vague-rule` | Content < 80 chars and no examples / no forbiddenActions. |
| `missing-examples` | Style/architecture rules need at least one example. |
| `missing-owner` | High/critical rules need `source.origin`. |
| `advisory-not-marked` | Tag `advisory` but `metadata.advisory` not set. |
| `advisory-has-unused-verification` | Advisory rule shipping verificationCommands. |
| `verification-references-unknown-script` | Verification command does not look like a known project script. |
| `missing-hints` / `missing-commands-or-mcp` / `missing-forbidden-actions` / `missing-verification` / `missing-write-policy` | Inherited from `diagnoseActionHints`. |

Advisory rules opt out of `missing-verification`,
`missing-commands-or-mcp`, `missing-forbidden-actions`, and
`missing-hints` by design — the whole point of an advisory rule is
that it does not need a verification command.

## Where to put the rule

| Audience | File |
| --- | --- |
| This repo only | `sharkcraft/rules.ts`. |
| A pack you maintain | the pack's `rules.ts` (then re-sign the pack — see `docs/pack-signatures.md`). |
| An external pack | the pack's own `rules.ts`. Do not edit pack-contributed assets in your own repo. |

## Hard rules

- `shrk rules scaffold` is preview-only by default.
- `--write-preview` writes only under `.sharkcraft/fixes/`.
- The scaffold contains no fake fields — every field maps to a real
  `IKnowledgeEntry` slot. If your schema-checker is unhappy, the
  scaffold is buggy, not your rule.
- The engine never edits `sharkcraft/rules.ts` for you. Move the
  scaffolded body in by hand and review it.

## See also

- `docs/custom-checks.md` — attach a deterministic external check to a rule.
- `docs/codemod-assist.md` — plan a cleanup based on a rule's findings.
- `docs/doctor-warning-quality.md` — how the new fields render in `shrk doctor`.
- `docs/safety-model.md` — the engine's invariants (no MCP writes, no fake signing).
