# Delegate worker (`shrk delegate`)

Hand a **mechanical, deterministically-verifiable** edit to a LOCAL-LLM worker so
the expensive orchestrator (e.g. Claude Code) burns fewer tokens. The worker
generates the edit locally; the **deterministic SharkCraft engine verifies it**
and **auto-reverts on failure** — so a bad generation costs a retry, never a
wrong write.

This is the Phase-1 MVP of the plan in
[`prompts/round-local-delegate-worker.md`](../prompts/round-local-delegate-worker.md).

## How it works

```
provider.send  →  parseDelegateEdit  →  checkGuardrailGlobs  →  packageDelegatePlan
              →  signPlan  →  savePlanToFile  →  (--apply) verify → evaluateSavedPlanInPlace
              →  writeSyntheticPlan  →  runValidationLoop  →  auto-revert on failure
```

The model is the ONLY stochastic step. Its output becomes a **signed synthetic
plan** (`templateId "__delegate/<recipe>"`) that flows through the SAME apply
primitives `shrk apply` uses. The model never writes files itself.

The local worker's prompt includes the **in-scope files' current contents**
(those matching the recipe's `guardrailGlobs`, compressed to signatures via the
code-outline pass, capped) so it can pick the right `targetPath`, respect
idempotency, and find exact text to replace — instead of guessing. This context
goes in the LOCAL worker's prompt, read on-machine, so it costs the orchestrator
(Claude) nothing.

### Four deterministic fences the model cannot influence

1. **Guardrail globs** (`checkGuardrailGlobs`, inspector) — an allow-list; a
   target path matching none of the recipe's `guardrailGlobs` is refused before
   any write, on top of the engine's `safeResolveTargetPath` traversal floor.
2. **Op-kind allow-list** (`packageDelegatePlan`, generator) — an op whose
   `kind` is not in the recipe's `allowedOps` is dropped, never packaged.
3. **Conflict-on-ambiguity** — `evaluateSavedPlanInPlace` turns an ambiguous
   anchor / missing file / `replace` matching 0 or >N into a conflict the apply
   pipeline refuses.
4. **Config-only verification** — a recipe may only NAME `verificationIds`; each
   must resolve to a `verificationCommands[].id` (the config validator errors on
   a dangling id). A pack can never inject an executable command.

A failed verification **auto-reverts** every written file (created files are
deleted, modified files restored), so the working tree is never left broken.

## Commands

```bash
shrk delegate list                                    # recipes + whether each is safely delegatable
shrk delegate explain <id>                            # the full fence for one recipe (audit before trusting)
shrk delegate brief "<task>" --recipe <id>            # read-only: show the fence + next step
shrk delegate run   "<task>" --recipe <id>            # generate + sign a plan (no write)
shrk delegate run   "<task>" --recipe <id> --apply    # + apply through the verify gate
shrk delegate run   "<task>" --recipe <id> --provider ollama --json
shrk delegate analyze "<task>" --recipe <id>          # read-only grounded ANALYSIS (never writes)
shrk delegate analyze "<task>" --recipe <id> --strict-grounding --json
```

`run` exits `0` for `applied` / `generated` / `no-provider` (no local LLM is a
no-op, never an error) and `1` otherwise (`guardrail-refused`, `conflicts`,
`package-error`, `verify-failed`, …). Every result carries a compact
**compressed unified diff** — for `--apply` it's exactly what changed; **without
`--apply` it's a PREVIEW** of what the worker would write (review it, then
`shrk apply <plan> --verify-signature` or re-run with `--apply`). Either way the
orchestrator sees the edit without re-reading the file.

`delegate list`/`explain` are read-only auditors: a recipe is **delegatable**
only when every `verificationId` resolves to a `verificationCommands[]` entry —
so you can confirm the fence is real before trusting a task type. `shrk doctor`
also surfaces this: a recipe whose verification isn't bound shows up as a
`delegate` Warning (`shrk delegate explain <id>` to fix), and an all-green
catalog shows an Ok check — so a silently-unusable recipe can't hide.

### Closed-loop retry

On a retryable failure (conflict, guardrail miss, bad op, or failed
verification) `run` re-prompts the worker with the failure injected, up to the
recipe's `maxAttempts` (default 2), then escalates. The `attempts` count is
reported. A provider / signing / environment failure is never retried.

## Configuring recipes (`sharkcraft.config.ts`)

```ts
export default defineSharkCraftConfig({
  verificationCommands: [
    { id: 'barrel-tsc', command: 'bun x tsc -p tsconfig.json --noEmit' },
  ],
  delegation: {
    enabled: true,
    provider: 'auto', // local-first: llamacpp → ollama; never hosted by default
    recipes: [
      {
        id: 'add-barrel-export',
        title: 'Add a re-export line to a barrel index',
        guardrailGlobs: ['src/**/index.ts'],
        allowedOps: ['export', 'ensure-import'],
        verificationIds: ['barrel-tsc'],
        riskCeiling: 'low',
      },
    ],
  },
});
```

## Pack-contributed recipes

A pack can ship delegate recipes so an org standardises its mechanical tasks.
The pack manifest declares `delegateRecipeFiles`, each `export default` an array:

```ts
// node_modules/@acme/shrk-pack/recipes.ts
import { defineDelegateRecipe } from '@shrkcrft/plugin-api';
export default [
  defineDelegateRecipe({
    id: 'add-barrel-export',
    guardrailGlobs: ['src/**/index.ts'],
    allowedOps: ['export'],
    verificationIds: ['barrel-tsc'],
  }),
];
```

A consuming repo can tune or disable a contributed recipe without forking it,
via `delegation.recipeOverrides` (keyed by recipe id):

```ts
delegation: {
  recipeOverrides: {
    'add-barrel-export': { model: 'qwen2.5-coder', verificationIds: ['my-tsc'] },
    'risky-recipe': { enabled: false },   // drop it from the catalog
  },
}
```

Resolution order: pack recipes, then INLINE config recipes override a pack
recipe of the same id, then `recipeOverrides` patch fields. `shrk delegate list`
shows each recipe's source (`[pack: …]`) and whether it is delegatable; the
verification ids are still bound against the consuming repo's
`verificationCommands[]` — so a pack can never run an unbound command.

## Analysis recipes (read-only, grounded)

A delegate recipe has a **mode**. The default (`patch`, everything above) produces
a fenced, deterministically-verified *edit*. An **`analysis`** recipe is
**read-only**: a local model adds *judgment* on top of a deterministic report the
engine runs first — it never writes.

```ts
delegation: {
  recipes: [
    {
      id: 'arch-risk-review',
      title: 'Architecture / risk review',
      mode: 'analysis',
      groundedOn: 'task-risk',   // the deterministic report the model is grounded on
    },
  ],
}
```

The two modes are **disjoint** — an `analysis` recipe carries no write-fence
(`guardrailGlobs` / `allowedOps` / `verificationIds`) and a `patch` recipe carries
no `groundedOn`. `shrk doctor` and the config validator both reject a recipe that
mixes them.

### How grounding keeps it honest

An analysis recipe has no plan/apply/verify gate (it never writes), so a different
fence keeps it trustworthy — the **grounding cross-check**:

1. The engine runs the recipe's `groundedOn` report (e.g. `buildTaskRiskReport`)
   FIRST and feeds it to the model as ground truth.
2. Each model finding may cite `refs` (files / constructs / reason-codes). The
   engine cross-checks every ref against the report's entities. A finding whose
   refs all resolve is tagged **`✓ grounded`**; one citing anything absent from the
   ground truth is tagged **`⚠ unverified`** (or dropped, with `--strict-grounding`).

So the model **prioritises and explains facts it cannot fabricate**. The output is
an advisory `sharkcraft.delegate-analysis/v1` report — never a plan, never a write.
With no local LLM reachable, `analyze` returns the deterministic grounding only
(exit `0`, a no-op — never an error), so the command always works.

Analysis runs the model **on the CLI only**. There is no MCP tool that runs a
model (the MCP read-only + never-runs-a-model invariant holds).

Grounding sources (`groundedOn`): `task-risk` (a task's deterministic risk report),
`agent-brief` (the pre-work brief for a task), `test-impact` (likely + missing tests
for a task/files), `plan-simulation` (a saved plan, via `--plan <path>` — see
plan-critique below), and `delegate-failure` (a failed patch attempt — see assisted
retry below).

A finding is `grounded` when it cites a ground-truth entity — either in an explicit
`refs` array, or (fallback) mentioned verbatim in its message prose (real models
routinely state facts without filling `refs`). A claim anchored to nothing in the
ground truth stays `unverified`.

### Fan-out (subagent-like output)

`fanOut: true` splits the grounding entities into deterministic slices and runs one
focused analysis pass per slice, then merges + dedups the findings — engine-owned
control flow (the model never schedules anything), for recipes where per-unit
isolation improves coverage. `maxFanOut` clamps the slice count `[2,6]` (default 3);
it is a no-op when the grounding has fewer than 2 entities.

### Plan critique + escalation

- **`plan-critique`** grounds on `plan-simulation`: `shrk delegate analyze "<note>"
  --recipe plan-critique --plan path/to/plan.json` critiques a saved plan (missing
  steps, risky ordering) — read-only, never applies.
- **`escalateTo`** names a PATCH recipe an analysis may hand a gap to (e.g.
  `test-gap-scan` → `scaffold-test-stub`). The report always surfaces an advisory
  next-command; `--escalate` additionally **generates** (never applies) that patch's
  signed plan through the four fences, from the advisory task — the human reviews +
  applies. `escalateTo` must resolve to an existing patch recipe (`shrk doctor` /
  the config validator enforce it).
- **`patch-suggest`** is simply a **patch** recipe used for a mechanical-but-
  judgment-tinged edit — no new surface; it flows through the same signed-plan →
  verify → apply → auto-revert gate, so a bad suggestion is caught and reverted.

### Bounded query loop (scoped tool-calling)

An analysis recipe may let the model pull a few **read-only** engine facts before
answering — a bounded fact-fetch loop, not an agent. It is opt-in per recipe:

```ts
{
  id: 'context-gather',
  mode: 'analysis',
  groundedOn: 'task-risk',
  allowedQueries: ['coverage', 'test-impact'],  // the ONLY queries the model may call
  maxQueryRounds: 2,                            // clamped [0,4]; 0 (default) = single-shot
  maxBudgetMs: 45000,                           // also wall-clock-bounds the loop
}
```

Each round, the model emits a JSON request naming queries from `allowedQueries`;
the engine runs only those (a request for anything else is **refused**
deterministically), feeds the results back, and repeats until the model is `done`,
the round cap is hit, or the budget is spent — then it produces its findings. The
available read-only queries (`DELEGATE_QUERY_IDS`) are `task-risk`, `coverage`,
`test-impact`, `graph-callers` (who calls a symbol, path:line), and `graph-context`
(a symbol's declaring file + importers/imports — the graph queries need `shrk graph
index`); there is deliberately **no** write/apply/gen/sign query. Facts the
model pulls are merged into the ground truth, so a finding citing a legitimately-
queried fact is `grounded`. This is implemented as an iterated JSON request (built
on `responseFormat: json_schema`, the robust path for weak local models), not
native provider tool-calling — the neutral message contract is unchanged.

### Assisted retry (`retry-analysis` + `--assisted-retry`)

A `retry-analysis` recipe grounds on **`delegate-failure`** — the ground truth is
the *failed patch attempt itself* (its status, conflicts, refused targets, dropped
ops, failed verifications). Run a patch recipe with `--assisted-retry`:

```bash
shrk delegate run "<task>" --recipe <patch-id> --apply --assisted-retry
```

Between retryable failures, the engine runs the `retry-analysis` recipe on the
failure, extracts the single **grounded** corrected instruction, and appends it as
a `Diagnostic hint:` to the deterministic retry feedback — so the patch worker's
next attempt is better informed. It is strictly **best-effort**: no `retry-analysis`
recipe or no local model → the loop runs exactly as before; the advisor never
blocks or changes the write gate. The corrected instruction is cross-checked
against the failure ground truth like any analysis finding.

### Over MCP (`delegate_analyze`)

`delegate_analyze` returns the **deterministic grounding** for an analysis recipe +
the exact `shrk delegate analyze` next command — it never runs a model and never
writes (the judgment layer runs on the CLI). A patch recipe returns `not-analysis`;
a `delegate-failure` recipe returns `needs-failure-context` (it only exists inside
the retry loop).

## What is (and is not) delegatable

A recipe is only as safe as its `verificationIds`. Delegate only MECHANICAL
edits with a deterministic ground-truth check (`tsc`, a test id, a graph query).
**Do NOT delegate** judgment or cross-file reasoning — API design, abstraction
choices, non-mechanical refactors, or anything touching
`sharkcraft.config.ts` / `packs/**` / `.git/**` / signing material.

## Hard rules preserved

- **No AI in the engine** — the model is touched only via `@shrkcrft/ai`'s
  `selectAiProvider` + `IAiProvider.send`, from the cli orchestrator.
- **MCP stays read-only** — there is no delegate MCP write tool.
- **CLI is the only write path** — the worker's edit only lands via the signed
  plan + `apply` primitives.
- **Local-only by default** — `provider: 'auto'` walks `llamacpp → ollama`;
  hosted providers require an explicit `--provider`.

## Delegating over MCP (`delegate_task`)

An agent (e.g. Claude Code) can fetch the delegation brief read-only:

```
delegate_task { task: "re-export './health'", recipe: "add-barrel-export" }
→ { recipeId, allowedOps, guardrailGlobs, verificationIds, provider, brief,
    next: "shrk delegate run \"…\" --recipe add-barrel-export --apply", note }
```

The tool never writes — it returns the fence + a compressed brief (CCR-reversible
when the server CCR store is present) + the exact CLI next command. The agent
hands the grunt edit to the local worker instead of spending its own tokens
reading the whole file and writing the edit.

## Token economics

`bun run delegate:token-eval` measures, per scenario, the tokens the orchestrator
pays — **baseline** (read the whole file + emit the edit) vs **delegated** (the
compact brief out + the compact result back), with a real BPE tokenizer
(`gpt-tokenizer`, degrades to the estimator). The worker's local generation
tokens are free to the orchestrator and excluded. Measured for `add-barrel-export`:

| target | baseline (tok) | delegated (tok) | saved |
|---|---|---|---|
| barrel, 20 exports | 213 | 169 | 21% |
| barrel, 100 exports | 853 | 169 | 80% |
| barrel, 400 exports | 3253 | 169 | 95% |

Savings scale with the size of the file the orchestrator would otherwise read;
the % is the trustworthy figure (absolute counts are approximate). This is a
per-scenario token-flow measurement, not a live session.

## Status / follow-ups

The patch path (Phases 1–2 of the original worker plan) is end-to-end and tested.
Phases 1–4 of the delegate-catalog extension (`prompts/round-delegate-catalog.md`)
are landed: **Phase 1** — `mode: 'analysis'` + `groundedOn: 'task-risk'` + the
grounding cross-check + `shrk delegate analyze`; **Phase 2** — the read-only
`delegate_analyze` MCP tool, the `delegate-failure` grounding source, the
`retry-analysis` recipe, and `--assisted-retry`; **Phase 3** — the bounded
read-only query loop (`allowedQueries` + `maxQueryRounds`, `DELEGATE_QUERY_IDS` =
`task-risk`/`coverage`/`test-impact`) and the `test-impact` grounding source;
**Phase 4** — fan-out (`fanOut`/`maxFanOut`), the `plan-simulation` grounding
source + `plan-critique` (`--plan`), and escalation (`escalateTo` + `--escalate`,
generate-only). **Follow-ups** — the `agent-brief` grounding source, graph-backed
queries (`graph-callers` / `graph-context`), `shrk delegate analyze --save`
(persists the report under `.sharkcraft/reports/`), an optional `plan` input on the
`delegate_analyze` MCP tool, richer `delegate list`/`explain` auditing of the full
fence, doctor health for the new config, and the prose-fallback grounding above.
All read-only except the existing patch gate.

Adding a grounding source or a query is a two-step change: extend
`DELEGATE_GROUNDING_IDS` / `DELEGATE_QUERY_IDS` (core) and wire its runner
(inspector grounding dispatch / cli query executor).

Until llama.cpp native-teardown child-process isolation lands, prefer
`--provider ollama` (HTTP, no native-teardown noise) for interactive runs.
