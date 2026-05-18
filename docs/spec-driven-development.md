# Spec-driven development (`shrk spec`)

`shrk spec` is an **intent artifact** layered over the existing
`shrk gen` / `shrk plan review` / `shrk apply` pipeline. It is NOT a
parallel "SDD mode." The same engine, the same safety contract, the
same deterministic outputs — `spec` just adds the structured
"what / why / how-we'll-know-it-shipped" artifact that lives in the
repo as an audit trail.

> Build it as `shrk spec <create|review|implement|verify>` over the
> existing infrastructure. Don't bolt on a parallel pipeline.
> — `planning2.md`

## When to use it

- Non-trivial features (more than a one-file fix or typo).
- Anything you want a back-pointer for later ("what change motivated
  this code?").
- Tasks the agent + human want to align on BEFORE generation runs.

For tiny fixes, skip `spec` and go straight to `gen` / `apply`. The
spec is overhead for tiny changes and value for substantial ones.

## Two paths: opinionated vs additive

R57 ships the opinionated path: `shrk spec` owns the
`sharkcraft.spec/v1` artifact in `.sharkcraft/specs/<id>/`. R58
ships the additive path for teams that already have their own
spec / plan format (Claude SDD plugin output, Cursor plans, ADRs in
`docs/architecture/`, etc.) — see [`docs/grounding.md`](./grounding.md).

| | Opinionated (R57) | Additive (R58) |
| --- | --- | --- |
| Artifact location | `.sharkcraft/specs/<id>/spec.md` | wherever the team already keeps plans |
| Format | `sharkcraft.spec/v1` frontmatter | any markdown with YAML frontmatter |
| Lifecycle verbs | `create / review / implement / verify` | `plan check` only |
| Status state machine | yes (draft → … → verified) | no |
| Audit trail | `events.jsonl` + provenance back-pointer | none — caller owns trail |
| If you uninstall shrk | the `.sharkcraft/` directory disappears | the repo is bit-identical to before |

Both paths share the same validation pipeline (`validateExtractedPlan`)
and the same registry checks. Pick the one that matches how your
team already works; you don't have to choose globally — a single
repo can use both.

## The four verbs

```
shrk spec create "<title>"   →  scaffolds .sharkcraft/specs/<id>/spec.md
shrk spec review <id>        →  validates the spec against the workspace
shrk spec implement <id>     →  composes proposedTemplates into a signed plan
shrk spec verify <id>        →  runs trusted verification + checks acceptance
```

Plus the ergonomics surface:

```
shrk spec list               →  every spec, newest-first
shrk spec show <id>          →  print spec contents
shrk spec status <id>        →  read or transition status
shrk spec lint <id>          →  fast structural-only validation
```

## Status state machine

```
draft ────────────► review ─────────► implementing
                       │                   │
                       │                   ▼
                       │              implemented
                       │                   │
                       │                   ▼
                       │              verified
                       │
                       ▼
                   abandoned (manual, requires --reason)
```

Transitions happen automatically when the matching verb succeeds.
The ONLY manually-allowed transition is `→ abandoned`, and it
requires `--reason "<text>"`.

## Frontmatter schema (`sharkcraft.spec/v1`)

```yaml
---
schema: sharkcraft.spec/v1
id: 2026-05-17-shrk-spec
slug: shrk-spec
title: shrk spec — intent artifact over plan/review/apply
status: draft
createdAt: 2026-05-17T08:00:00.000Z
updatedAt: 2026-05-17T08:00:00.000Z

intent: |
  One-paragraph statement of what is being built.

motivation: |
  Why now. Forcing function. Cross-link to issue if any.

acceptanceCriteria:
  - id: ac-1
    text: shrk spec create writes a file under .sharkcraft/specs/.
    verifiedBy: [tests]

affectedAreas:
  files:
  packages: [packages/cli, packages/generator]
  layers: [cli, generator, inspector]

relevantRules:
  - repo.generation.dry-run-by-default

relevantKnowledge: []
relevantPaths:
  - engine.packages

proposedTemplates:
  - templateId: engine.cli-command
    variables:
      name: spec

risks:
  - id: r-1
    text: Specs grow into novels.
    mitigation: Hard byte cap.

outOfScope:
  - LLM-assisted spec drafting

externalLinks:
  issue: null
  pr: null

boundariesCheck:
  predicted: []

verificationCommands:
  - id: typecheck
  - id: unit-tests
---

# Body

Free-form markdown. Architecture sketches, decision notes.
```

The body is inert documentation — the engine reads frontmatter only.
The body length is capped (default 16 KiB) to force structure;
configurable via `sharkcraft.config.ts spec?: { bodyMaxBytes }`.

## Design hazards (verbatim from `planning2.md`)

1. **Don't reinvent issue tracking.** The spec is not a substitute
   for Linear / Jira. It is the engineering artifact: precise,
   structured, machine-readable. Cross-link to issues via
   `externalLinks.issue`; don't replace them.
2. **Specs must stay short.** A spec that needs 5 pages of prose has
   failed. The schema forces structure (YAML frontmatter); a hard
   byte cap on the body warns when it grows out of bounds.
3. **Avoid AI-in-the-engine creep.** The engine never writes specs.
   Specs are written by the human or the agent; `shrk` validates,
   grounds, and executes them. Same invariant as today's plans.
4. **Bidirectional traceability.** Every commit that lands via
   `spec implement --apply` should carry the spec ID in the commit
   trailer (`RelatedSpec: <id>`). Provenance entries written by
   apply carry a `relatedSpec` field — the schema bumps to
   `sharkcraft.asset-provenance/v2` when populated.
5. **Verification commands must be trusted.** `spec verify` only runs
   commands declared in `sharkcraft.config.ts verificationCommands[]`
   with `trusted: true`. Pack-contributed verification stays
   advisory. This matches the R44 hard rule.

## Commit trailer recipe

```
git commit -m "feat(x): add ...

Spec: .sharkcraft/specs/<id>/spec.md
RelatedSpec: <id>"
```

Mechanical enforcement of the trailer is deferred. `spec verify`'s
acceptance-criteria coverage check treats a missing trailer as
advisory.

## Storage layout

```
.sharkcraft/specs/<id>/
  spec.md            — frontmatter + markdown body (authoritative)
  spec.json          — canonical derived view (regenerated on every mutation)
  plan.json          — signed combined plan (after `implement --write-plan`)
  verification.json  — most recent `verify` report
  events.jsonl       — per-spec audit log
```

The spec directory name is a stable human-greppable id; it does NOT
change when the spec is edited. The `frontmatterHash` / `bodyHash`
fields in `spec.json` are sha256 digests and DO change with content.

## Schemas

| Schema | Where |
| --- | --- |
| `sharkcraft.spec/v1` | spec.json |
| `sharkcraft.spec-review/v1` | review report |
| `sharkcraft.spec-implement/v1` | implement-plan envelope |
| `sharkcraft.spec-verification/v1` | verify report |
| `sharkcraft.spec-events/v1` | events.jsonl entries |
| `sharkcraft.spec-list/v1` | `spec list` output |
| `sharkcraft.asset-provenance/v2` | provenance entries with `relatedSpec` |

## Read-only MCP tools

- `mcp__sharkcraft__list_specs`
- `mcp__sharkcraft__get_spec`
- `mcp__sharkcraft__get_spec_review`
- `mcp__sharkcraft__get_spec_verification`

NO write tools for spec mutation. Spec create / implement / verify
are CLI-only by design. This preserves the R44 safety contract that
MCP is strictly read-only.

## What R57 does NOT ship

- `shrk spec import <development/feature_N.md>` — converting the
  existing feature corpus into specs.
- LLM-assisted spec drafting (the engine never calls a model).
- Spec composition / parent-child specs.
- GitHub / Linear issue API integration.
- Commit-trailer enforcement via a git hook scaffolder.
- `shrk spec diff <a> <b>` — structured diff between spec versions.
- `shrk knowledge propose --from-spec <id>`.

These are R58+ candidates. Document them in the spec's
`outOfScope` field when they come up so future-you knows they were
intentionally deferred.
