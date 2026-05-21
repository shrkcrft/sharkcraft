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

## Safety

- Individual boost values are clamped to `|5|`.
- Total tuning contribution per document is capped at `|10|`.
- Tuning never filters — it only nudges scores.
- Invalid tuning files are ignored with `shrk search tuning doctor`
  warnings.

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
