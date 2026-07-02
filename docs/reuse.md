# Reuse (intent → the canonical primitive)

The single most-violated convention in many large codebases is *"reuse the
existing primitive instead of re-implementing it."* It's also the hardest one
for an agent to satisfy by `grep`: the symbol name it needs isn't in a barrel's
text (a barrel is `export *`), and deep utilities sit many directories down,
effectively ungreppable.

`shrk reuse "<intent>"` closes that gap. A project declares its canonical
primitives as data in `sharkcraft.config.ts` `reusePrimitives[]`, keyed by
role/intent. The command matches your intent to a primitive, then uses the
**code graph** to resolve the symbol to its real declaration, its **sibling
exports**, and real **consumer files to copy**. For the public **import path**
it uses the configured `importPath` (the only source of a copy-pasteable import
line); if omitted, it surfaces a re-exporting barrel as a hint. Deterministic;
no AI.

## Configuring primitives

```ts
export default defineSharkCraftConfig({
  reusePrimitives: [
    {
      symbol: 'Button',                       // the canonical exported symbol
      roles: ['button', 'clickable control'], // intent labels matched against the query
      importPath: '@scope/ui',                // the public specifier consumers should import from
      description: 'The shared button — variants, sizes, a11y built in.',
      keywords: ['cta', 'submit'],            // optional, widens matching
    },
  ],
});
```

| field | meaning |
|---|---|
| `symbol` | the canonical exported symbol to reuse (resolved in the graph) |
| `roles` | intent labels; `shrk reuse "<intent>"` matches query tokens against these (+ `keywords`, `symbol`, `description`) |
| `importPath` | the public import specifier (barrel/package entry). The only source of a copy-paste `import` line. When omitted, `reuse` shows the declaration site + a re-exporting barrel hint (it never emits a deep-file import) |
| `description` | one-line "when to reach for this" |
| `keywords` | extra free-text terms to improve matching |

## Running it

```bash
shrk reuse "I want to add a button"     # ranked primitives + import + consumers
shrk reuse "date formatting" --limit 1  # cap the number of matches (default 3)
shrk reuse "<intent>" --json            # machine-readable (schema: sharkcraft.reuse/v1)
```

Output per match: the symbol, the import line, where it's declared, its sibling
exports, and a few real consumer files you can copy from. With no matching
primitive, it lists the available roles so you can refine the intent.

## Match confidence

`reuse` won't dress up a weak guess as an answer. A **lone weak keyword
collision** — a single non-symbol token hitting on a multi-token intent — is
**not** returned as a confident match: the command prints `No confident match`
plus a *did-you-mean* list (`--json`: `confident: false`, `didYouMean:
[{ symbol, score, confidence, matched }]`) so you refine the intent instead of
copying the wrong primitive. Each confident result exposes its `score`,
`confidence` (`0..1` — the fraction of intent tokens matched), and the `matched`
tokens. The consumer list is labeled with its true size —
`consumers to copy (N total, showing 5)` — and `--json` carries `consumerTotal`.

## Requirements & behavior

- **Build the code graph first** (`shrk graph index`) for import-path
  resolution, siblings, and consumers. Without it, `reuse` still returns the
  configured symbol + `importPath` (from config), with a note that the richer
  resolution is unavailable.
- Consumers are resolved via graph references — including `new`/type/DI usage,
  not just call expressions — so "copy a real consumer" works even for classes
  that are never *called*.
- The registry is generic: shrk hard-codes no symbol. Keep `reusePrimitives[]`
  focused on the handful of primitives most worth reusing.
