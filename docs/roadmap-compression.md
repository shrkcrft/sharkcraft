# Compression roadmap — future developments (detailed)

A detailed, implementable plan for pushing `@shrkcrft/compress` further on
token-reduction performance. Each item is a mini-spec: problem, approach
(with the exact shrk files), acceptance criteria, test plan,
effort/risk/dependencies, and expected payoff.

Grounded in two prior efforts:
- a **parity audit** (which deterministic techniques shrk hasn't adopted), and
- the 2026-06-16 **ground-truth validation** (`scripts/compress-validate.ts`,
  real `cl100k_base` tokens), which proved **−50% aggregate** real-token
  reduction (markdown −44%, source-outline −55%, build-log −89%,
  knowledge-graph −19%) and surfaced the concrete weaknesses below.

---

## 1. Current state (the baseline we improve from)

| Surface | Real before → after | Real % |
|---|---|---|
| Knowledge graph (45 nodes) | 1353 → 1100 | −19% |
| Markdown (`docs/compression.md`) | 2789 → 1565 | −44% |
| Source outline (`compress-log.ts`) | 1698 → 759 | −55% |
| Build log (64 lines) | 1355 → 155 | −89% |
| **TOTAL** | **7195 → 3579** | **−50%** |

Proven properties: deterministic, CCR-reversible, lossless where claimed, MCP
read-only, table default-on, CLI `--json` minified, ~24 MCP tools wired.

Quantified weaknesses this roadmap targets:
1. **Estimator absolute counts are rough** (±up to 74% vs real; the *percentage*
   is sound). The dashboard + `maxTokens` budget ride on it.
2. **Savings scale with payload size** — small lists barely win (the −19% graph
   is small at 45 nodes).
3. **Unadopted deterministic techniques**: diff-noise offload,
   log-template mining, adaptive sizing, BM25 relevance, mixed-content split.
4. **Default-on columnar's comprehension cost is unmeasured** (could partly
   offset wire savings).
5. **Object-keyed maps don't compact** (only arrays of objects do).
6. A **wire-vs-handler schema-drift class of bug** (today's `maxTokens`
   Critical) is unguarded generically.

---

## 2. Invariants every change MUST preserve (non-negotiable)

Any item below is rejected if it breaks one of these:

- **Determinism.** Same input bytes → same output bytes. No clock, no RNG, no
  network, no learned state at request time. (Same rule that keeps the engine
  model-free.)
- **Losslessness or reversibility.** A pass is either *lossless* (exactly
  reconstructable from its own output, e.g. columnar / log-template) or *lossy
  but CCR-reversible* (the original is cached and recoverable via
  `retrieve_original` / `shrk expand`). Never lossy-and-unrecoverable.
- **Net-loss guard.** If a pass doesn't shrink the *final* string (marker
  overhead included), it passes through unchanged — see `text/finalize.ts`.
- **MCP read-only.** No new MCP tool writes disk; MCP CCR stays in-memory
  (`InMemoryCcrStore`), file-backed only on the CLI.
- **Wire/handler schema parity.** Any tool input added must appear in BOTH the
  tool `inputSchema` AND its strict zod validator in
  `server/tool-input-validators.ts`, or the wire rejects it (the handler test
  won't catch it — it bypasses the validator).

## 3. Non-goals (out of scope by the no-model rule)

ML prose compression, image/OCR compression, cross-agent memory, and any
online-learning loop. The engine stays a pure function of input. A real
**tokenizer** is permitted as a *dev/measurement* dependency only (it is a
lookup table, not a model) — never on the deterministic engine path.

## 4. Prioritization & dependency graph

Order by **token-impact × ease ÷ risk**. Measurement first (you cannot improve
what you cannot honestly measure), then cheap-big wins, then smarter selection,
then comprehension/format quality, then scale infra.

```
P1 (measure+harden) ──┬─► P2 (big wins) ──► P3 (smarter selection)
                      └─► P4.1 comprehension eval ──► P4.2 read-accuracy formats
P2/P3/P4 each report through P1.1 (real tokenizer) + P1.4 (floors)
P5 (scale infra) is independent, do last
```

---

## Phase 1 — Prove & harden

Low-risk, high-leverage. Makes every later claim measurable and catches a whole
bug class. Do this first.

### P1.1 — Honest token accounting
- **Problem.** The deterministic estimator (`tokens/estimate-tokens.ts`,
  chars/token heuristic) is accurate on *percentages* but off up to **74%** on
  *absolute* counts. The dashboard Token-Savings panel
  (`cli/src/dashboard/dashboard-api-server.ts → buildDashboardCompression`) and
  the `maxTokens` budget present these absolutes as if exact.
- **Approach.** Keep the estimator as the engine default (model-free rule). Add
  an **optional** real-tokenizer path used only by measurement/UI surfaces:
  - A tiny `scripts/lib/real-tokens.ts` helper that dynamically imports
    `gpt-tokenizer` (already a dev dep) and exposes `realTokens(s): number | null`.
  - Dashboard: either (a) label the numbers "≈ estimated tokens", or (b) when a
    tokenizer is present, compute exact counts server-side and mark them "exact".
    Prefer (a) as the always-on default, (b) as an enhancement.
- **Files.** `cli/src/dashboard/dashboard-api-server.ts`,
  `dashboard/src/routes/compression.page.tsx` (label), new `scripts/lib/real-tokens.ts`.
- **Acceptance.** Dashboard never presents an estimate as exact; when a
  tokenizer is available the displayed counts match `compress-validate.ts`
  within ±1 token.
- **Tests.** Unit: `realTokens` returns null when the dep is absent (graceful).
  Dashboard endpoint test asserts a `tokensAreEstimated: boolean` flag in the
  response.
- **Effort S · Risk Low · Deps none.**

### P1.2 — Session-level measurement harness
- **Problem.** We've proven *per-payload* savings, not *per-session*. The goal
  ("agents pay fewer tokens") is a session-level outcome.
- **Approach.** A script that replays a fixed, realistic **task transcript** — a
  scripted sequence of MCP tool calls a coding agent makes for a representative
  task (e.g. `get_start_here` → `get_task_packet` → `get_knowledge_graph` →
  `search_all` → `list_rules`) — and totals real tokens with `SHRK_MCP_TABLE`
  on vs off, plus per-tool breakdown. Deterministic (fixed transcript, real
  repo, real tokenizer). Extends `scripts/compress-validate.ts`.
- **Files.** new `scripts/compress-session-eval.ts`; reuse the tool registry
  (`mcp-server/src/tools`) and `scripts/lib/real-tokens.ts`.
- **Acceptance.** Prints `total tokens table-off → table-on (−X%)` for a named
  transcript; reproducible run-to-run.
- **Tests.** A smoke test asserting the harness runs and reports a non-negative
  reduction on the bundled transcript.
- **Effort M · Risk Low · Deps P1.1.**

### P1.3 — Schema-parity guard (generalize today's Critical fix)
- **Problem.** `compress_context` advertised `maxTokens` in its `inputSchema`
  but the strict zod validator rejected it on the wire — the feature was dead in
  production and the handler test couldn't see it.
- **Approach.** A test that, for every tool with both an `inputSchema` and an
  entry in `TOOL_INPUT_SCHEMAS` (`server/tool-input-validators.ts`), builds a
  representative input covering **every** advertised property and asserts
  `validateToolInput(name, input).ok === true`. Drift fails CI.
- **Files.** new `mcp-server/src/__tests__/schema-parity.test.ts`.
- **Acceptance.** Adding a property to any tool's `inputSchema` without updating
  its zod validator turns the suite red.
- **Effort S · Risk Low · Deps none.**

### P1.4 — Extend the regression floor
- **Problem.** `payload-savings-floor.test.ts` floors only 4 surfaces; the
  newly-wired tools + lossy compressors only assert directional (saved>0).
- **Approach.** Add per-surface floors for the 6 newly-wired tools and a couple
  of real-tokenizer floors (dev-only, skipped when the tokenizer is absent).
- **Files.** `mcp-server/src/__tests__/payload-savings-floor.test.ts`.
- **Acceptance.** A change that bloats any covered surface past its floor fails
  the build.
- **Effort S · Risk Low · Deps P1.1.**

---

## Phase 2 — Big deterministic token wins

The largest untapped reductions. Each is lossless or CCR-reversible.

### P2.1 — Diff-noise offload
- **Problem.** `text/compress-diff.ts` keeps lockfile churn
  (`package-lock.json`/`yarn.lock`/`pnpm-lock.yaml`/`Cargo.lock`/`go.sum`/…) and
  whitespace-only hunks verbatim — the single largest source of useless diff
  tokens.
- **Approach.**
  1. Split the unified diff into per-file sections by `diff --git`/`+++ b/<path>`
     headers (the splitter already exists for hunk handling).
  2. Classify a file as **lockfile** by basename against a fixed set; replace its
     entire body with a one-line `[lockfile: ±N lines elided → <<ccr:KEY>>]`,
     CCR-caching the original section. Keep the file header.
  3. Detect **whitespace-only hunks** (every changed line differs only in
     leading/trailing whitespace after `\s+`-normalisation) → elide with a
     `[whitespace-only hunk: N lines → <<ccr:KEY>>]` marker.
  4. Net-loss guard + CCR reversibility apply.
- **Files.** `packages/compress/src/text/compress-diff.ts`; a small
  `text/lockfile-names.ts` constant; tests in
  `packages/compress/src/__tests__/`.
- **Acceptance.** A diff with a 2,000-line `package-lock.json` change compresses
  that section to one marker line; `retrieve_original` reconstructs it exactly;
  real-tokenizer reduction on a mixed lockfile+code diff ≥ 60%.
- **Tests.** lockfile elision + CCR round-trip; whitespace-only elision; a
  code-only hunk is untouched; net-loss passthrough on a tiny diff.
- **Effort M · Risk Low · Deps none. Payoff: HIGH on PR/CI diffs.**

### P2.2 — Drain-style log-template mining (lossless)
- **Problem.** `text/compress-log.ts` keeps repeated structured lines
  (`worker-3 processing batch 17 ok` × N) verbatim or drops them; it can't
  collapse them.
- **Approach.** A simplified **Drain**: tokenize each line, replace variable
  tokens (integers, hex, UUIDs, ISO timestamps, quoted strings, paths) with
  `<*>` to form a template keyed by (token-count, first-N fixed tokens). Group
  **consecutive** lines sharing a template; emit
  `[T{k} ×{N}] {template}` followed by a compact variant table of the captured
  `<*>` tuples (omit the table when variants are themselves trivial/low-entropy).
  **Lossless** — template + ordered variant tuples reconstruct every original
  line in order, so no CCR needed. Runs as a pre-pass before the existing
  signal-selection in `compressLog`.
- **Files.** new `packages/compress/src/text/log-template.ts`; integrate in
  `text/compress-log.ts`; tests.
- **Acceptance.** 200 `worker-N`/`batch-N` lines collapse to one template +
  variant table; exact reconstruction; real-tokenizer reduction ≥ 70% on a
  repetition-heavy log; non-repetitive logs are unchanged.
- **Tests.** reconstruction equality (lossless) over a fuzz corpus; mixed
  template/error log keeps the error line; order preserved.
- **Effort M · Risk Low (lossless) · Deps none. Payoff: HIGH on noisy CI logs.**

### P2.3 — Object-map columnar
- **Problem.** `json/compress-json.ts` only compacts *arrays* of objects. A JSON
  **object keyed by id** with homogeneous values (`{n1:{kind,score}, n2:{…}}` —
  a very common API/registry shape) gets zero compaction.
- **Approach.** When `parsed` is a non-array object whose values are all plain
  objects sharing a core schema (≥ `MIN_ENTRIES`, ≥ `CORE_RATIO` column
  presence — mirror `table/compact-object-array.ts`), hoist to
  `{_omap:{keys:[…], cols:[…], rows:[…], absent:[…]}}`, exactly reconstructable
  to the original keyed object. Add `expandObjectMap` (inverse). Lossless,
  net-loss guarded.
- **Files.** new `packages/compress/src/table/object-map.ts` (+ inverse);
  wire into `json/compress-json.ts`; export from `index.ts`; tests.
- **Acceptance.** A 50-key homogeneous map round-trips losslessly and shrinks;
  heterogeneous maps fall through unchanged; property-fuzz `expand∘compact === id`.
- **Effort S · Risk Low · Deps none. Payoff: MEDIUM (common shape).**

---

## Phase 3 — Smarter selection (better token/fidelity tradeoff)

### P3.1 — Adaptive sizing
- **Problem.** Lossy samplers use fixed caps (`table/sample-object-array.ts`:
  anchors=8, outliers=8, matches=16, maxItems=200; log/search/diff `maxItems`).
  Fixed K keeps too much on redundant data and too little on diverse data.
- **Approach.** `computeOptimalK(items, {bias})`:
  1. Order items by existing priority.
  2. Build the **unique-bigram coverage curve** (cumulative distinct token-
     bigrams as items are added); the marginal curve flattens at saturation.
  3. Find the **knee** via Kneedle (max of the normalized difference curve).
  4. Cross-check with a **simhash** near-duplicate collapse (don't count items
     within Hamming distance H as new information) and a **zlib-ratio** sanity
     bound (stop if added items are highly compressible ⇒ redundant).
  5. Per-tool `conservative|moderate|aggressive` bias shifts the knee.
  Deterministic (pure functions of bytes). Replaces the fixed defaults *only when
  no explicit cap is passed*; explicit `maxItems` still wins.
- **Files.** new `packages/compress/src/table/adaptive-size.ts` (+ simhash,
  bigram, kneedle helpers); consume in `table/sample-object-array.ts` and the
  text compressors; tests.
- **Acceptance.** On a redundant corpus it keeps materially fewer rows than
  fixed-K at equal coverage; on a diverse corpus it keeps more; deterministic;
  never exceeds an explicit cap.
- **Effort L · Risk Medium (changes what's kept — gate behind tests + floors) ·
  Deps P1.4. Payoff: MEDIUM–HIGH, data-dependent.**

### P3.2 — BM25 / hybrid relevance
- **Problem.** Query biasing uses bare token-overlap counting
  (`text/line-utils.ts queryOverlap`) — weak on single-term and ID/UUID exact
  matches.
- **Approach.** A small pure **BM25** scorer (k1=1.2, b=0.75; idf from the
  candidate corpus; per-row/line length norm) that pins top-scoring rows/lines
  into the keep set; boost exact-match weight for ID-shaped terms
  (UUID/hex/email). Keep `queryOverlap` as the fallback when no query. Optional
  later: adaptive-alpha hybrid (BM25 + a deterministic embedding) — only if a
  deterministic embedding source exists (else out of scope).
- **Files.** new `packages/compress/src/relevance/bm25.ts`; consume in
  `table/sample-object-array.ts`, `text/compress-log.ts`,
  `text/compress-search.ts`; tests.
- **Acceptance.** With a query, a uniquely-relevant row that token-overlap ranks
  low is retained; deterministic; no query ⇒ identical to today.
- **Effort M · Risk Medium · Deps none. Payoff: MEDIUM (query-biased fetches).**

---

## Phase 4 — Comprehension & format quality (de-risk default-on columnar)

### P4.1 — Agent-comprehension eval (do before P4.2)
- **Problem.** Columnar+legend saves *wire* tokens but may cost *reasoning*
  tokens or cause reconstruction errors — currently unmeasured. This is the one
  open risk on the default-on flip.
- **Approach.** A reproducible eval: take N real columnar payloads, ask a model
  (offline/local where possible) to answer fixed extraction questions
  ("how many nodes have kind=file?", "list ids where score>0.8") from (a) the
  bare-array form and (b) the columnar form; score accuracy and measure
  *response* tokens. Net benefit = wire-tokens-saved − extra-reasoning-tokens,
  weighted by accuracy delta.
- **Files.** new `scripts/compress-comprehension-eval.ts` + a small fixed
  question set.
- **Acceptance.** Produces a per-format accuracy + net-token table; documents
  whether default-on columnar is net-positive, neutral, or negative, and on
  which payload shapes.
- **Effort M · Risk Low · Deps P1.1. This decides whether P4.2 is needed.**

### P4.2 — Read-accuracy formats (CSV-schema / Markdown-KV)
- **Problem / gate.** If P4.1 shows columnar JSON hurts comprehension on some
  shapes, offer alternative encodings chosen for model read-accuracy
  (CSV/Markdown-KV).
- **Approach.** Add `tableFormat: 'columnar'|'csv'|'mdkv'` to
  `FORMAT_INPUT_PROPERTY`/`columnar-format.ts`; emit the chosen encoding (all
  still reversible). Default chosen by P4.1's evidence.
- **Files.** `mcp-server/src/server/columnar-format.ts`,
  `packages/compress/src/table/*`; **must** update the zod validators (P1.3
  guard enforces this).
- **Effort M · Risk Medium · Deps P4.1, P1.3.**

### P4.3 — Mixed-content router split
- **Problem.** `compress-content.ts` routes the *whole* blob to one compressor;
  a blob mixing prose + a JSON block + a stack trace is compressed sub-optimally.
- **Approach.** Segment a blob into runs by detected type (reuse
  `content/detect-content-type.ts` per-segment with boundary heuristics:
  fenced code, contiguous JSON, log-line runs), compress each with its strategy,
  reassemble with segment markers; reversibility composes from each segment.
- **Files.** `packages/compress/src/compress-content.ts` +
  `content/segment.ts`; tests.
- **Effort M · Risk Medium · Deps none.**

### P4.4 — Detection fixes
- **Problem.** `content/detect-content-type.ts` mis-routes `tsc`/MSVC
  `src/a.ts(10,5): error` diagnostics to SourceCode (the search regex wants
  `path:line:`), has no YAML or CSV/TSV class, and uses uncalibrated 0.25/0.45
  thresholds.
- **Approach.** Add a `(line,col):`-diagnostic pattern → SearchResults; add YAML
  (`^\s*[\w-]+:\s`) and CSV/TSV (stable delimiter count per line) classes;
  calibrate thresholds against a labelled fixture corpus.
- **Files.** `content/detect-content-type.ts`; a labelled corpus test.
- **Effort S · Risk Low.**

### P4.5 — `compressLog` elision hint
- **Problem.** When `compressLog` drops a run, the agent can't tell a root cause
  was elided.
- **Approach.** Emit inline `[… N lines elided → <<ccr:KEY>>]` at each drop
  boundary (CCR key already exists for the full original).
- **Files.** `text/compress-log.ts`. **Effort S · Risk Low.**

---

## Phase 5 — Scale infra (last)

### P5.1 — Pluggable CCR backends with TTL
- **Problem.** CCR is in-memory (MCP) or a single-machine file store (CLI), no
  TTL/eviction policy, no cross-process retrieval.
- **Approach.** A `ICcrStore` backend interface already exists; add an
  sqlite-backed store with TTL + size eviction for the CLI; keep MCP in-memory
  (read-only contract). Config-selected.
- **Files.** `packages/compress/src/ccr/*`. **Effort M · Risk Medium.**

### P5.2 — Wire SmartCrusher into the big-array tools
- **Problem.** `sampleObjectArray` is reachable only via `compress_context`
  `maxTokens`; the large-array tools (`get_knowledge_graph`, `deps_audit`) never
  invoke it.
- **Approach.** Add an optional `maxTokens` to those tools that routes the
  homogeneous array through `compressJson({maxTokens})` when over budget (CCR in
  the MCP store). Honour the P1.3 schema-parity guard.
- **Files.** the relevant `mcp-server/src/tools/*.tool.ts` + their zod
  validators. **Effort S · Risk Low.**

---

## 5. Measurement methodology (how each phase proves itself)

Every item lands with:
1. A **real-tokenizer** before/after in `scripts/compress-validate.ts` (and, for
   tool-level work, `compress-session-eval.ts` from P1.2).
2. A **regression floor** in `payload-savings-floor.test.ts` where applicable.
3. **Reversibility/losslessness** tests (round-trip equality, CCR recovery).
4. A note in `docs/compression.md` if the surface or default changes.

**Definition of done for the whole roadmap:** lift the *verified* aggregate
above today's **−50%** on representative payloads (and materially higher on
diff/log-heavy payloads via P2.1/P2.2), **without** regressing comprehension
(P4.1), determinism, or losslessness/reversibility.

## 6. Cross-cutting risks & mitigations

| Risk | Mitigation |
|---|---|
| A lossy/heuristic pass drops real signal | CCR-reversible + net-loss guard + size fixtures ABOVE the savings threshold in tests (small fixtures passthrough and mask behaviour) |
| Default/contract drift breaks clients | wire/handler schema-parity guard (P1.3); `format:"json"` always forces the explicit shape |
| Columnar hurts comprehension | P4.1 measures it before P4.2 commits to formats |
| Estimator misleads tuning | P1.1 real-tokenizer for measurement surfaces |
| Heuristic edge cases (the code/log/diff scanners have a long tail) | adversarial review + property fuzz before merge; every pass stays CCR-recoverable |

## 7. Appendix — technique → shrk mapping

| technique | shrk status | roadmap item |
|---|---|---|
| diff-noise offload | not adopted | P2.1 |
| log-template mining | not adopted | P2.2 |
| adaptive sizing | not adopted | P3.1 |
| BM25 / hybrid relevance | partial (overlap only) | P3.2 |
| read-accuracy formats | not adopted | P4.2 |
| mixed-content router | not adopted | P4.3 |
| exact tokenizer budgeting | not adopted (estimator) | P1.1 (measurement only; engine stays model-free) |
| pluggable CCR backends | partial (mem + file) | P5.1 |
| object-map compaction | not adopted | P2.3 |
| ML prose / image / cross-agent-memory / online-learning compression | **out of scope** (no-model rule) | — |
