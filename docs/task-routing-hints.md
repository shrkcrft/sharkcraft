# Task routing hints (R33)

Packs and local config bias SharkCraft's recommender toward their
playbooks / templates / helpers / profiles / conventions / knowledge
through `taskRoutingHintFiles[]`. The engine ships no hints.

Locally, `sharkcraft/task-routing-hints.ts` (or `task-routing-hints/index.ts`)
is picked up by convention. List any extra files in `sharkcraft.config.ts`,
relative to `sharkcraft/`:

```ts
export default {
  // …
  taskRoutingHintFiles: ['hints/extra.ts'],
};
```

Packs list theirs under `contributions.taskRoutingHintFiles` in the manifest.

## Shape

```ts
interface ITaskRoutingHint {
  id: string;
  title: string;
  description?: string;
  match: { keywords?; phrases?; regexes?; languages?; fileGlobs?;
           constructKinds? };
  recommends: { commands?; templates?; playbooks?; helpers?;
                profiles?; conventions?; knowledge?; policies?;
                pipelines?; rules?; paths? };
  confidenceBoost?: number;
  explanation?: string;
  safetyNotes?: readonly string[];
  tags?: readonly string[];
}
```

## Commands

> **CLI verbs retired — MCP-only surface.** The standalone `routing` CLI
> verbs (`routing hints list`, `routing hints doctor`, `routing explain`)
> were removed. The deterministic engine survives as the read-only MCP
> tools `list_task_routing_hints` and `explain_task_routing` (see below).
> No CLI write path, no execution — the hints are read-only data.

## MCP

- `list_task_routing_hints`, `explain_task_routing` — read-only.

## Integrations

- `shrk recommend "<task>"`, MCP `recommend_commands` and `shrk context`
  (Top commands) fold every matched hint's `recommends.commands` into ONE
  ranked list, one row per command in declared order, attributed
  (`routing hint "<id>" (score 7, floor 3)`). A hint's floor is 3 (one phrase,
  or two keyword/regex hits); its normalised score is `score / 3`, ranked
  against the shared ranker, the built-in recipes and the intent fallback —
  a hint at or above its floor always outranks a weaker fallback, for every
  intent, and makes the answer `confident`. See docs/command-entrypoints.md.
- `shrk search "<query>"` — best actions section pulls top-scoring
  routing hints.
- `prepare_agent_task` MCP tool — includes routing hints with reasons.

## Matching and load lints (round 11)

The matcher scores `keywords` (+2 each), `phrases` (+3) and `regexes` (+2)
against the task string, keywords and phrases through THE term matcher
(`match-terms.ts`, the same one playbooks, the recommender's recipes and
change-intent use):

- `match.mode: 'tokens'` (the default) — both sides are lowercased and split
  into terms on anything that is not a letter or digit; a needle's terms must
  appear CONTIGUOUSLY in the task, each equal or one plain inflection apart
  (`gate` ~ `gates`, `refactor` ~ `refactoring`, `boundary` ~ `boundaries`).
  So `capability-pack` ≡ "capability pack" ≡ `capability_pack`, and `ci` never
  fires inside "pricing", `gate` never inside "investigate", `block` never on
  "blocker". A 2-letter term matches only itself.
- `match.mode: 'substring'` — the legacy raw `task.toLowerCase().includes(needle)`,
  for a hint that wants infix matching (`auth` inside "authentication"). Its
  reasons record the mode: `keyword: auth (substring)`.

Back-compat: tokens mode is strictly narrower than the old substring default —
it removes infix false positives. A hint that relied on infix matching sets
`mode: 'substring'`. `regexes` are unaffected (a regex is already an explicit
mode). `languages`, `fileGlobs` and `constructKinds` are
RESERVED — published, not scored today (no caller passes a file/language
context). The loader lints every hint and the issues reach `shrk self-config
doctor` as `routing-hint-<code>`:

| code | severity | |
|---|---|---|
| `invalid` / `duplicate-id` | error | validator failure (incl. an unknown `match.mode` or a non-string keyword/phrase/regex array) / an id loaded twice |
| `short-substring-keyword` | warning | a keyword/phrase under 4 characters in `mode: 'substring'` — it fires inside unrelated words (`ui` in "build") |
| `load-failed` / `missing-file` | warning | a hint file that failed to import, or a pack-declared one that is absent; the doctor also counts it as an unexamined `hint files` unit, so the verdict is never a pass |
| `invalid-regex` | error | a regex that does not compile (it never matches) |
| `empty-trigger` | error | an empty keyword/phrase — every task contains it |
| `unscored-match-criteria` | warning | only `languages` / `fileGlobs` / `constructKinds`: the hint can never match |
| `no-match-criteria` | warning | no keyword, phrase or compiling regex at all |
| `ignored-match-criteria` | info | unscored criteria beside scored ones |
| `duplicate-trigger` | warning | two hints with the same criteria (both ids named) |
| `unknown-recommends-key` | warning | a `recommends` key that is not a channel (`pipeline` for `pipelines`) |

`recommends` channels resolve through one table (`ROUTING_RECOMMENDS_CHANNELS`):
templates, playbooks, helpers, profiles (migration profiles), conventions,
knowledge, policies, pipelines, rules, paths (path conventions) — each id is
probed by the self-config doctor; `commands` go through the command resolver.
`prepare_agent_task` returns every resolved non-command id as
`recommendedAssets` (`{ kind, id, hintId }`) and each matched hint's
`recommends`.

## Schemas

- Hint shape: described by `ITaskRoutingHint` (no schema marker).
- Registry: `sharkcraft.task-routing-hint-registry/v1`.
