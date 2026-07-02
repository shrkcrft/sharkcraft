# Registry inventory (`shrk registry <name> …`)

Many projects keep a **registry**: a set of string-keyed contributions declared
across several files (built-ins + per-module contributions + extension packs).
"Is this id already taken? where is it declared? what binds it?" is a
multi-root grep an agent re-runs every time and often gets wrong (wrong scan
roots → a colliding id that only fails a slow test later).

`shrk registry <name>` answers those questions with **one deterministic,
alias-blind, multi-root scan** — no AI, no language-specific knowledge. The
registry is declared as data, reusing the same `{ files, pattern |
arrayProperty }` extractor as [wiring rules](./wiring.md).

> This is the inventory side of the `registry` verb. For register/remove
> teardown symmetry see [`shrk registry lifecycle`](./registry-lifecycle.md).

## Declaring a registry

Add a `registries[]` entry to `sharkcraft.config.ts`:

```ts
export default defineSharkCraftConfig({
  registries: [
    {
      name: 'commands',
      description: 'CLI command ids',
      // Where the ids are declared, and how to extract them (group 1 = the id).
      source: { files: ['src/**/*.command.ts'], pattern: "name:\\s*'([\\w-]+)'" },
      // Optional: where each id is consumed / bound (a dispatcher, allowlist…).
      consumer: { files: ['src/main.ts'], pattern: "register\\('([\\w-]+)'\\)" },
      // Optional: human synonyms that resolve to a canonical id (see --resolve).
      aliases: { 'ls': 'list', 'cmd-list': 'list' },
    },
  ],
});
```

`source` (and the optional `consumer`) are wiring `IWiringSource`s — so you can
use `arrayProperty` instead of `pattern` to harvest ids from an array literal,
exactly as in a wiring rule.

## Querying

```bash
shrk registry commands list              # every declared id + site count
shrk registry commands exists <id>       # hard yes/no — exit 0 if taken, 1 if free
shrk registry commands where <id>        # declaration (and consumer) sites, file:line
shrk registry commands list --json       # machine-readable (ids[], diagnostics[])
shrk registry commands where <id> --json # { found, entry: { sites, consumerSites } }
```

Exit codes are meaningful: `registry … exists <id>` returns `0` when the id is
declared and `1` when it is not, so it composes in a script ("fail if the id is
already taken"). An **unknown registry name** errors with exit `2` and lists the
declared registries — it never silently succeeds with an empty answer.

### Guard mode & alias resolution

`registry <name> exists <id>` gains two guard flags that make it a drop-in
precondition in a shell `&&` chain, plus a synonym resolver:

- `--fail-if-taken` — exit **non-zero when the id IS registered** (`0` when
  free), so `shrk registry <name> exists <id> --fail-if-taken && <author>` is a
  natural pre-author guard: author only if the id is still free.
- `--fail-if-missing` — the symmetric consume-side check: non-zero when the id is
  **not** registered (assert an id you depend on exists before wiring to it).
- `--resolve` — map a human synonym to the canonical id via the registry's
  `aliases` map **before** the existence test, and print the resolved id. Declare
  it as `registries[].aliases: { <synonym>: <canonicalId> }`; the `--json`
  payload carries `resolvedId` when it differs from the input.

The scan finds ids wherever the globs reach — built-in declarations *and*
pack-contributed registration files — against ground truth, so the answer
doesn't drift as contributions move between files.

## When to reach for it

Any "string-keyed contribution set spread across files" you'd otherwise grep:
command ids, route names, event types, feature flags, plugin slugs, permission
keys. If you also need to assert the set is *complete* (declared ⊆ registered),
use a [wiring rule](./wiring.md); the registry verb is for **inventory** lookups
("taken? where?").
