# Task understanding v2 (R27)

R26 shipped `shrk understand-task` with token-matching for likely files.
R27 promotes it to a multi-signal ranker.

## Signals (additive)

- **Token matching** — same as R26, but tokens shorter than three chars are
  discarded and longer matches score higher.
- **Construct vocabulary** — file paths attached to constructs whose id or
  title shares tokens with the task get +6.
- **Language vocabulary** — the task is mined for `angular`, `java`,
  `python`, etc. Files whose extension matches the task's language get +1.
  When the task doesn't mention a language, detected polyglot languages are
  used.
- **Symbol-ish matching** — filename, class, function tokens.
- **Stability boost / penalty** — files in `public-api` / `stable` areas
  get +3; files in `deprecated`/`legacy` areas get -3 and a warning.
- **Dependency-graph proximity** — files with high fan-in from
  `analyzeImportGraph` get +2.
- **Memory hotspot boost** — files with historical conflicts / failures
  get up to +6 and a warning.
- **Generated-code exclusion** — generated files get -10 (drops them) and
  are reported separately.
- **Path-convention boost** — files matching a known path convention get
  +1.
- **Construct/facet boost** — pack-contributed construct paths receive a configurable boost.

The result is a sorted list with `score` and `reasons[]`.

## CLI

```bash
shrk understand-task "<task>"                 # ranked list (text)
shrk understand-task "<task>" --explain       # one block per file with reasons
shrk understand-task "<task>" --format markdown --explain
shrk context build --task "<task>" --explain
```

Output fields:

- `likelyFiles` — top-60 ranked file paths.
- `likelyFilesExplained` — same, with `score` + `reasons`.
- `likelyConstructs` — `{ id, title, reason }`.
- `likelyLanguages` — task or detected languages.
- `likelyTests` — sibling `*.test.ts` / `*_test.go` / `*_test.py` etc.
- `riskyGeneratedFiles` — generated files that token-matched but should NOT
  be hand-edited.
- `stabilityWarnings`, `memoryWarnings` — surface-level reasons to be
  careful.
- `suggestedFirstCommands` — derived from constructs / impact / stability
  signals.
- `confidence` — 0–100, scaled by signal coverage.

## MCP

`understand_task` is read-only. The same output shape is returned plus a
next-command hint.

## Safety

Read-only. No file is read past what `inspectSharkcraft` and the existing
inspectors already touch.
