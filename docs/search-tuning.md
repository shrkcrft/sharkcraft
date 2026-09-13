# Search tuning

`defineSearchTuning` lets local config and packs bias SharkCraft's
deterministic search ranker without filtering results. Tuning is loaded
from `sharkcraft/search-tuning.ts` (local) and pack
`contributions.searchTuningFiles`.

```ts
import { defineSearchTuning } from '@shrkcrft/plugin-api';

export default [
  defineSearchTuning({
    id: 'my.bias',
    appliesToKinds: ['rule', 'template'],
    boostTags: { plugin: 3 },
    boostSources: { pack: 1 },
    taskHints: [
      {
        whenTokens: ['plugin'],
        boostIds: { 'rule:my-rule': 4 },
        boostKinds: { playbook: 2 },
      },
    ],
  }),
];
```

## Boost keys (round 11)

`boostIds` keys are SEARCH-DOCUMENT ids — `<kind>:<id>`, exactly what `shrk
search` prints. The matcher compares the key to the document id whole, so a
bare id (`'my-rule'`) never matches anything. Valid prefixes (the ones the
index emits): `knowledge`, `rule`, `path`, `template`, `pipeline`, `boundary`,
`construct`, `playbook`, `preset`, `pack`, `bundle`, `session`, `facet`,
`doc`. Decisions, policies and scaffold patterns are not search documents, so
no key can target them. `shrk search tuning doctor` resolves every key within
its kind and suggests the prefixed form of a bare one.

**Intended-empty boosts (round 13).** A boost for a document that does not
exist yet — a pack boosting the guide an adopting app will write — marks the
VALUE; the unit is the key ([intended-empty.md](intended-empty.md)):

```ts
boostIds: { 'knowledge:acme.routing-guide': { weight: 2, expectEmpty: true, reason: 'apps write it on adoption' } },
taskHints: [{ whenTokens: ['routing'], boostIds: { 'knowledge:acme.routing-guide': { weight: 3, expectEmpty: true } } }],
```

The loader keeps the weight (clamped like any boost) and records the key in
the entry's `expectEmptyUnits` — it is never clamped to 0, which is what an
older engine does with an object value. Every boost value must be a number
(or, in `boostIds` / `taskHints[].boostIds` only, a well-formed marker): a
string, a malformed marker, or a marker in `boostTags` / `boostSources` /
`boostKinds` makes the entry a REJECTED entry (`invalid-entry`, an error). Only
a missing TARGET can be marked: a marker on an unprefixed key, an unknown kind
or a kind the entry's `appliesToKinds` excludes is refused — those keys can
never fire, whatever exists.

## Triggers

`taskHints[].whenTokens` must ALL appear in the query's tuning tokens: every
whitespace/punctuation-separated token (hyphens kept — `changed-only`, `c#`)
plus its alphanumeric pieces, tokens of 2+ characters. ONE tokenizer feeds
`shrk search`, `shrk task`, `shrk context` and `shrk why`, so a trigger fires
in all of them or none. A trigger with whitespace or a separator (`'two
words'`), or shorter than 2 characters, can never fire — the doctor reports it
(`unreachable-trigger`).

## Safety

- Individual boost values are clamped to `|5|`.
- Total tuning contribution per document is capped at `|10|` — reported, never
  silent: the boost carries `capped: { raw, applied }` and a `tuning-cap:`
  reason, `explain` lists a `total` row in `cappedBoosts`, and the doctor
  reports documents the cap clips (`cap-discards`).
- Tuning never filters — it only nudges scores.
- Invalid tuning files are ignored with `shrk search tuning doctor`
  warnings.

## Doctor

`shrk search tuning doctor [--strict] [--fail-on-dead-units] [--allow-empty] [--format text|json]`
runs THE search-tuning lint (the self-config doctor renders the same issues,
prefixed `search-tuning-`). The flags work in any position — `shrk search
--fail-on-dead-units tuning doctor` and `shrk search tuning --fail-on-dead-units
doctor` run the doctor (round 13: in those positions the flag used to swallow
the next word and run a search or the listing at exit 0). `--format json` (or
`--json`) prints JSON; `--format markdown|html` is a usage error (3).

| code | severity | |
|---|---|---|
| `target-missing` | warning | `<kind>:<id>` whose id is not registered in that kind |
| `key-unprefixed` | warning | a bare id — never matches a document |
| `key-unknown-kind` | warning | the prefix is not a document kind |
| `boost-excluded-by-kind` | warning | the entry's `appliesToKinds` excludes the key's kind |
| `duplicate-trigger` | warning | two task hints of one entry with the same `whenTokens` |
| `unreachable-trigger` | warning | a `whenToken` no query can produce (or none at all) |
| `unknown-kind` / `unknown-source` | warning | `appliesToKinds` / `boostKinds` / `boostSources` naming no search kind / source |
| `cap-discards` | info | a document whose tuning exceeds the ±10 cap for a real trigger set |
| `target-intended-empty` | info | round 13: a missing target every declaration of which is marked `{ weight, expectEmpty: true }` — accepted, printed |
| `expect-empty-went-live` | info | round 13: a marked key that now resolves — `expectEmpty is stale`; remove the marker |

**Each issue's target (round 12, 12.4).** The self-config doctor labels what
each issue names, and `unknown:` is RESERVED for a key that resolves nowhere:

| the issue names | self-config target | e.g. |
|---|---|---|
| a key or document THE key resolver / the index places | `tunes <kind>:<id>` | `target-missing`, `boost-excluded-by-kind` on `rule:fx.rule`, a resolvable bare `key-unprefixed` (`alpha.entry` → `knowledge:alpha.entry`), `cap-discards` on `knowledge:gamma.entry` → `knowledge:gamma.entry`, a clamped `boostIds` key |
| a document or key with no id registry, or the cap summary | `tunes search-document:<id>` | `doc:README.md`, `3 more document(s)` |
| a declaration, not an id | `validates schema:<field>` | `duplicate-trigger` / `unreachable-trigger` → `taskHints[1].whenTokens`, `unknown-kind` → `appliesToKinds` / `taskHints[0].boostKinds`, `unknown-source` → `boostSources`, a clamped tag → `boostTags.<tag>` |
| a key that resolves NOWHERE | `tunes unknown:<the whole key>` | a bare id no registry lists, `key-unknown-kind` (`knowlege:alpha.entry` — its right-hand id may well exist) |

It used to fall back to `unknown:` for every issue without a registry kind —
the capped document, the resolvable bare key, a tag, a `doc:` key and even the
finding code — while the one really missing id rendered without it.
`--json` issues carry the locators additively: `field` (the declaration a
shape issue is about), `moreDocuments` (the cap summary), and on a
`cap-discards` document with an id registry `referenceKind` + the bare
`targetId`; a `boost-clamped` loader issue carries `field` (the map its key
came from). A bare key that resolves carries its `referenceKind`.

`probes` counts distinct keys by status. Dead keys, dead task hints and
unverifiable keys are `coverage` shortfalls, so the exit is 2 over them (1 on
errors, on warnings with `--strict`, or on dead units with
`--fail-on-dead-units`). No tuning declared at all is 2 as well — nothing was
verified — unless `--allow-empty` accepts it (the acceptance is printed).

Round 13: every key and task hint settles through THE liveness authority. A
missing target whose every declaration is marked is intended-empty — no dead
unit, and `search tuning: accepted by expectEmpty: …` on the verdict (`--json`
`accepted`); a key marked in one entry and not in another stays dead (the
unmarked boost never fires). A marked key that resolves went live: the ✓ is
withheld, `--fail-on-dead-units` fails a LOCAL stale marker (1), a pack's is
INFO and never fails. A marker never accepts an UNVERIFIABLE key (its kind's
registry is empty, or has no id registry): it stays a coverage gap (2). `--json`
adds `units: { dead, intendedEmpty, wentLive }`.

**Not implemented (round 11, spec 1.3 fix #4):** "match counts over a sample of
recent queries". SharkCraft keeps no query log, so there is no sample to count
against; the doctor's trigger checks (`unreachable-trigger`, `duplicate-trigger`,
`cap-discards`, …) are static over the declared tuning only. `shrk search tuning
explain` / `why` show what one given query matches.

## CLI

```bash
shrk search tuning list                              # registered entries
shrk search tuning doctor                            # invalid / clamped warnings
shrk search tuning explain <query>                   # explain how tuning affects a query
shrk search tuning explain <query> --format markdown
shrk search tuning explain <query> --format html
shrk search tuning explain <query> --format json
```

`explain` shows: query tokens, loaded tunings, matched boost categories,
which boosts were clamped, and a before / after score table for the top
results.

## Composition (R14)

When multiple tunings touch the same boost key (a tag, an id, a kind),
SharkCraft used to sum every contribution. R14 introduces an opt-in
`mergeStrategy`:

```ts
defineSearchTuning({
  id: 'my.bias',
  mergeStrategy: 'max',           // 'sum' (default) | 'max'
  boostTags: { plugin: 3 },
});
```

- `sum` (default): every contributing tuning's value adds up. The
  global ±10 cap still clips the total.
- `max`: when **any** contributor on a key declares `mergeStrategy: 'max'`,
  the combined boost is the contributor with the largest absolute value.
  Useful when overlapping packs all boost the same tag and you don't want
  them to stack.

The strategy is decided per-key, not per-tuning: `max` wins if any
single contributor on the key opts in. `shrk search tuning explain`
reports the strategy in a "Composition" block whenever a key has more
than one contributor:

```
- `rule:repo.architecture.respect-boundaries`
  - tag:service (strategy=max): [my.bias +3, other.bias +2] → +3
```

## MCP (read-only)

- `list_search_tuning` — registered entries + load issues.
- `explain_search_tuning` — same payload as `shrk search tuning explain`,
  including the per-key composition entries from R14.
