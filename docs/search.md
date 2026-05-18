# Unified search (`shrk search`)

`shrk search <query>` runs a deterministic, AI-free ranker across every
SharkCraft registry plus docs / sessions / bundles. No vectors, no
embeddings — just stable scoring on id / title / tags / appliesWhen /
content / fields.

## Usage

```bash
shrk search "<query>"
shrk search "<query>" --type rules,templates,paths
shrk search "<query>" --source local,pack
shrk search "<query>" --limit 50
shrk search "<query>" --explain
shrk search "<query>" --json
```

Supported `--type` values: `knowledge`, `rule`, `path`, `template`,
`pipeline`, `preset`, `pack`, `boundary`, `policy`, `doc`, `session`,
`bundle`, `construct`, `construct-facet`, `playbook`, `scaffold-pattern`,
`command`.

Supported `--source` values: `local`, `pack`, `session`, `bundle`,
`builtin`, `doc`.

## How ranking works

Each hit is scored from:

1. **id match** — exact id or suffix match scores highest.
2. **title match** — exact then fuzzy.
3. **tag match** — bonus for tags overlapping the tokens.
4. **appliesWhen match** — small bonus for relevant scope tags.
5. **content match** — body / description token presence.
6. **field match** — extra fields (boundary `from/to`, path glob, etc.).
7. **kind weight** — rules / knowledge / templates / playbooks weighted higher.
8. **priority bonus** — `critical/high/medium/low` markers boost the score.

Hits are grouped by kind and capped by `--limit` (default 30). Use
`--explain` to surface the matched fields per hit.

## Pack tuning (R12)

Packs and local config can bias the ranker via `defineSearchTuning`:

```ts
// sharkcraft/search-tuning.ts
import { defineSearchTuning } from '@shrkcrft/plugin-api';

export default [
  defineSearchTuning({
    id: 'my.bias',
    appliesToKinds: ['rule', 'template'],
    boostTags: { plugin: 3 },
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

Packs ship tuning via `contributions.searchTuningFiles`. Individual
boosts are clamped to `|5|` and the overall tuning contribution per
document caps at `|10|`. Tuning never filters; it only nudges. Use
`shrk search "<query>" --explain` to see `tuning:<id>` reasons.

```bash
shrk search tuning list
shrk search tuning doctor                              # surfaces clamp / load issues
shrk search tuning explain <query>                     # R13: explain how tuning affects a query
shrk search tuning explain <query> --format markdown   # also html / json
```

See [`docs/search-tuning.md`](search-tuning.md) for the full tuning
authoring model + explainability output.

MCP: `list_search_tuning` returns entries + doctor issues;
`explain_search_tuning` returns the explainability report.

## MCP

- `search_all` — same payload, read-only.
- `list_search_tuning` — pack/local tuning + load issues.
