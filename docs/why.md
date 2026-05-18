# `shrk why <file>`

> *"Given a file or symbol, explain the constraints that apply to it:
> which layer it's in, what it can import, what depends on it, which
> conventions it must satisfy. This would be the single most useful
> onboarding feature."*
> — feedback3.md

`shrk why <file>` answers that question for a file. Read-only.
Composes existing registries — no LLM, no shell, no writes.

## Usage

```bash
# Plain text output (human-facing).
shrk why packages/inspector/src/safety-audit.ts

# Structured JSON for skills / plugins.
shrk why packages/inspector/src/safety-audit.ts --json

# Limit how many rules / knowledge entries appear.
shrk why src/foo.ts --limit 5
```

The verb works on:
- **files** (`kind: file`) — full registry match.
- **directories** (`kind: directory`) — same query, applied to the
  directory.
- **missing paths** (`kind: missing`) — when the input doesn't exist
  on disk, the verb still tries to infer the package shape, and
  routes you to `shrk knowledge search` / `shrk search`.

## What it surfaces

| Block | Source | What it means |
| --- | --- | --- |
| `inferredPackage` / `inferredLayer` | filesystem heuristic | `packages/<x>` / `apps/<x>` / `libs/<x>` / `tools/<x>` parsed from the path |
| `pathConventions` | `paths` registry | path-convention entries whose canonical path matches the target |
| `rules` | `rules` registry | rules whose `scope` / `tags` / `appliesWhen` overlap with path tokens, ranked by priority |
| `boundaries` | `boundaries` registry | boundary rules whose `from` glob matches the target — these dictate what the file can import |
| `knowledge` | knowledge entries | entries that reference the file or mention its basename |
| `suggestedNext` | composition | concrete next commands you can copy-paste |

Every entry includes the source file (`source: …`) when available
via the inspector's `entrySources` map — i.e. the file where the
rule / path convention / knowledge entry is *defined*. That's the
"rule provenance — why does this rule exist" answer from
feedback3.

## What it does NOT do

- **Symbol queries.** `shrk why <symbol>` would require an AST pass.
  Out of scope for the first cut. The verb refuses with a hint that
  routes to `shrk knowledge search "<symbol>"`.
- **Boundary violations.** `shrk why` shows the rules that CONSTRAIN
  this file's imports; it does NOT run them. For violations use
  `shrk check boundaries` (which the verb suggests in `suggestedNext`).
- **AST-level fan-in / fan-out.** "Who depends on this file" needs
  the import graph. Use `shrk graph imports` (which the verb
  suggests when relevant).

## Schema

`sharkcraft.why/v1` — see `packages/inspector/src/why-file.ts` for
the full TypeScript types.

## How it relates to other verbs

- `shrk grounding "<task>"` is task-shaped ("what's relevant to this
  goal?"). `shrk why <file>` is file-shaped ("what's relevant to this
  path?"). Use grounding when you have a task in mind, why when you
  have a path in mind.
- `shrk rules get <id>` shows ONE rule. `shrk why <file>` shows the
  rules that apply to THIS file. Use rules-get when you know the id,
  why when you have the path.
- `shrk impact <path>` shows the blast radius of changing the file.
  Use impact when you're about to change the file, why before you
  start.
