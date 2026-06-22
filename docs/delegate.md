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

Phases 1–2 are end-to-end and tested. Deferred (see the plan): a
`delegate list`/`explain` auditor + a closed-loop retry loop (Phase 3),
pack-contributed recipes + llama.cpp native-teardown child-process isolation
(Phase 4). Until child-isolation lands, prefer `--provider ollama` (HTTP, no
native-teardown noise) for interactive runs.
