# AI Issue Workflow — Phase 1 Plan

**Status:** Plan (not implemented).
**Scope:** Phase 1 = plan-only. No file changes, no branch, no commit, no PR, no publish.
**Audience:** Maintainers reviewing the proposal; future implementer (human or agent).

This document is the authoritative plan for the AI Issue Workflow. Phase 2 (implement
mode) is sketched only enough to confirm the Phase 1 boundaries don't paint us in.

---

## 1. Goal

Let an authorized human file a GitHub issue and have an agent post a structured plan
comment back, deterministically and safely, without ever modifying the repository.

**Non-goals (Phase 1):**
- No code generation, no file writes, no commits, no branches, no PRs.
- No publish, no release tagging, no infrastructure changes.
- No interactive `/ai` comment commands.
- No re-runs on `edited` / `reopened`.
- No multi-runner orchestration or tool-use loops — Phase 1 is a single model call.

**Non-negotiables:**
- The existing `ci.yml` is the only validator. It stays unchanged and remains the
  single source of validation truth for any future AI-authored PR.
- The workflow file is a thin, stable shell. All logic lives behind `tools/ai-agent/run.ts`.
- The runner (model call) sits behind an `IAgentRunner` interface and is the only
  replaceable component.

---

## 2. Architecture

Two strictly decoupled pipelines:

```
  push / pull_request                      issues
        |                                     |
        v                                     v
  ci.yml (existing, validator)         ai-issue.yml (new, actor)
        |                                     |
  typecheck/build/lint/test            gate -> sanitize -> context -> runner -> comment
        |                                     |
        +<-------- AI-authored PRs (Phase 2) -+
                  flow through CI like any human PR
```

The AI workflow never validates code. The CI workflow never calls models. They share
nothing but the repo itself.

**Lifecycle of an issue event:**

```
issues.opened | issues.labeled
        |
        v
  gate(event) -------> 'ignore'    -> exit 0, no side effect
        |
        +--------> 'implement' -> exit 0, log "deferred to Phase 2", no comment
        |
        +--------> 'plan'      -> sanitize -> context -> runner -> post comment
                                            |
                                       on error -> classify -> post failure comment -> exit 1
```

---

## 3. Stability boundary

The whole point of this design is that the workflow file and orchestration stay
stable while the runner (the part that calls a model) is the swap point.

| Layer | Lives in | Changes when? |
| --- | --- | --- |
| Triggers, permissions, secrets wiring | `.github/workflows/ai-issue.yml` | Almost never |
| Orchestration: gate, sanitize, context, comment, telemetry, error mapping | `tools/ai-agent/run.ts` + `src/*` | Rarely (bug fixes) |
| Runner: model call, prompting, token accounting | `tools/ai-agent/src/runner/*` behind `IAgentRunner` | Frequently — this is where new agent runtimes plug in |

The workflow knows nothing about Claude, prompts, or token caps. It knows: "run
`bun tools/ai-agent/run.ts`, surface the exit code."

---

## 4. File layout

```
.github/
  workflows/
    ai-issue.yml                     # thin, stable shell (~25 lines)

tools/ai-agent/
  run.ts                             # entrypoint; the only thing the workflow invokes
  src/
    orchestrate.ts                   # gate -> sanitize -> context -> runner -> comment
    gate.ts                          # pure: event -> AgentMode | 'ignore'
    sanitize.ts                      # pure: untrusted text -> safe ISanitizedIssue
    context.ts                       # shells out to `shrk task` (Bun-direct invocation)
    github.ts                        # post issue comment via GITHUB_TOKEN (fetch)
    telemetry.ts                     # format telemetry for step summary + comment footer
    errors.ts                        # ErrorCategory enum + classify(err)
    runner/
      types.ts                       # IAgentRunner, IAgentRunInput, IAgentRunOutput, AgentMode
      factory.ts                     # createRunner(): IAgentRunner — single swap point
      claude-plan-runner.ts          # Phase 1 implementation (Anthropic SDK)
    config/
      allowed-actors.ts              # getAllowedActors() — reads SHARKCRAFT_AI_ALLOWED_ACTORS
      maintainers.ts                 # getMaintainers() — reads SHARKCRAFT_AI_MAINTAINERS
      labels.ts                      # LABELS = { plan: 'ai:plan', implement: 'ai:implement' }
      model.ts                       # MODEL_ID = 'claude-opus-4-7'
      limits.ts                      # token caps, byte budgets, timeouts
    prompts/
      system.md                      # immutable safety contract + role
      plan.md                        # plan-mode user template
  __tests__/
    gate.test.ts                     # decision matrix coverage
    sanitize.test.ts                 # injection / size / control-char cases
    orchestrate.test.ts              # uses a fake IAgentRunner
    claude-plan-runner.test.ts       # Anthropic SDK mocked
```

Everything under `tools/ai-agent/` is checked-in TypeScript, lint-and-test-ready.
The workflow file itself is intentionally trivial.

---

## 5. Workflow file specification

Single file: `.github/workflows/ai-issue.yml`. Approximate shape (illustrative, not
code to commit yet):

```yaml
name: AI Issue

on:
  issues:
    types: [opened, labeled]   # deliberately narrow: no edited, no reopened, no comments

permissions: read-all          # workflow-level floor

concurrency:
  group: ai-issue-${{ github.event.issue.number }}
  cancel-in-progress: false    # queue, don't cancel

jobs:
  ai-issue:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    permissions:
      contents: read
      issues: write            # only what we need to post a comment
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun tools/ai-agent/run.ts
        env:
          GITHUB_EVENT_PATH:  ${{ github.event_path }}    # provided by Actions
          GITHUB_TOKEN:       ${{ secrets.GITHUB_TOKEN }}
          GITHUB_REPOSITORY:  ${{ github.repository }}
          GITHUB_SERVER_URL:  ${{ github.server_url }}
          GITHUB_RUN_ID:      ${{ github.run_id }}
          GITHUB_STEP_SUMMARY: ${{ runner.temp }}/step-summary.md   # Actions provides
          ANTHROPIC_API_KEY:  ${{ secrets.ANTHROPIC_API_KEY }}
```

**Why these choices:**
- `issues.types: [opened, labeled]` — minimal trigger surface. No re-trigger on edits.
- `permissions: read-all` workflow-level, escalate per job. Phase 1 only ever needs
  `issues: write` plus `contents: read`.
- `concurrency` keyed on issue number prevents racing runs on the same issue.
- `cancel-in-progress: false` — if a queued run is still relevant, let it complete;
  otherwise the gate inside `run.ts` will short-circuit it.
- `timeout-minutes: 15` is the outer ceiling. Runner deadline is tighter (see §10).
- No `pull_request_target`, no `workflow_run`, no reusable-workflow secret inheritance.

---

## 6. Orchestration flow (`run.ts`)

`run.ts` is a tiny entrypoint that delegates to `orchestrate.ts`. The flow:

1. Read GitHub event JSON from `GITHUB_EVENT_PATH` (Bun: `await Bun.file(path).json()`).
2. `mode = gate(event)` — pure function over `event.action`, `event.issue.user.login`,
   `event.issue.title`, `event.issue.labels`, and (for `labeled` events) `event.sender.login`.
3. Switch on `mode`:
   - `'ignore'` — write a short denial reason to `$GITHUB_STEP_SUMMARY`, exit 0.
   - `'implement'` — write "implement mode deferred to Phase 2" to step summary, exit 0.
     No comment posted (avoids noise; Phase 2 will activate the path).
   - `'plan'` — continue.
4. `sanitized = sanitize(event.issue)` — see §11.
5. `context = await collectContext(sanitized.title)` — shells `shrk task "<title>"`,
   captures stdout, applies size cap.
6. `runner = createRunner()` — returns `IAgentRunner`. Phase 1: `ClaudePlanRunner`.
7. `output = await runner.run({ mode: Plan, issue: sanitized, context, limits, signal })`
   — `signal` from `AbortController` bound to runner deadline.
8. `body = formatComment(output, telemetry)` — assembles markdown plan + telemetry footer.
9. `await postComment(event.issue.number, body)`.
10. Write the same telemetry block to `$GITHUB_STEP_SUMMARY`.
11. Exit 0.

**Error handling:** everything from step 4 onward runs inside a single try/catch. On
caught error: `category = classify(err)`, then `postFailureComment(issueNumber, mode, category, runUrl)`,
log the full error + stack to `console.error`, exit non-zero. Pre-gate errors (event
parse failure, gate exception) do not post — they show up in Actions logs only.

---

## 7. The `IAgentRunner` interface

The runner is a pure transform: sanitized input -> markdown comment body. It must
not touch the filesystem, git, the network beyond the model API, or the GitHub API.

```ts
// tools/ai-agent/src/runner/types.ts (sketch, not committed yet)

export enum AgentMode {
  Plan = 'plan',
  Implement = 'implement',
}

export interface ISanitizedIssue {
  number: number;
  title: string;          // already sanitized, capped, control-chars stripped
  body: string;           // ditto, ASCII-safe
  authorLogin: string;
}

export interface IRepoContext {
  shrkTaskOutput: string; // already capped
  // Room to add: shrkContextOutput, repoStats, etc. — additive only.
}

export interface ITokenLimits {
  maxInputTokens: number;   // pre-call estimate hard cap
  maxOutputTokens: number;  // SDK max_tokens
  deadlineMs: number;       // wall clock budget for the runner
}

export interface IAgentRunInput {
  mode: AgentMode;          // 'plan' in Phase 1; 'implement' added in Phase 2
  issue: ISanitizedIssue;
  context: IRepoContext;
  limits: ITokenLimits;
  signal: AbortSignal;
}

export interface IAgentRunTelemetry {
  modelId: string;
  inputTokens: number | null;   // null if SDK didn't surface it
  outputTokens: number | null;
  durationMs: number;
}

export interface IAgentRunOutput {
  commentMarkdown: string;
  telemetry: IAgentRunTelemetry;
  // Phase 2 will add: changes?: IProposedChange[]
  // Additive. Phase 1 orchestration ignores any unexpected fields.
}

export interface IAgentRunner {
  run(input: IAgentRunInput): Promise<IAgentRunOutput>;
}
```

**Factory:**

```ts
// tools/ai-agent/src/runner/factory.ts (sketch)
export function createRunner(): IAgentRunner {
  return new ClaudePlanRunner();    // Phase 1: hard-coded.
}
```

Phase 2 swap: one line in `factory.ts` (optionally env-gated). No workflow change,
no orchestration change.

**Construct conventions** (per `CLAUDE.md`): one exported top-level construct per file,
interfaces prefixed with `I`, no logic in constructors. The `types.ts` exception:
related types co-locate for cohesion; the file exports a single logical group.

---

## 8. Phase 1 runner: `ClaudePlanRunner`

- Uses `@anthropic-ai/sdk` directly (Bun-native fetch).
- Loads `prompts/system.md` and `prompts/plan.md` from disk at runtime so prompt
  changes are diffable PRs, not code edits.
- Single `messages.create` call. `model: MODEL_ID` from `config/model.ts`.
- Input shape:
  - `system` parameter: contents of `system.md`.
  - `messages[0].content`: contents of `plan.md`, with placeholders replaced for the
    `<repo-context>` and `<issue>` blocks. The `<issue>` block is the only place
    untrusted data appears, clearly labeled.
- Enforces `input.limits.maxInputTokens` via a pre-call estimate (`countTokens` or a
  byte/4 heuristic if the SDK doesn't expose it cheaply). Rejects with a
  `runner_token_limit` error before making the API call.
- Passes `max_tokens: input.limits.maxOutputTokens` to the SDK.
- Passes `input.signal` to the SDK call. Maps `AbortError` -> `runner_timeout`.
- Returns the model's text content as `commentMarkdown`. Pulls `usage.input_tokens`
  and `usage.output_tokens` from the response for telemetry.
- **Cannot:** write files, run shell commands, call GitHub APIs, read anything not
  passed in via `IAgentRunInput`. These constraints are enforced by code review and
  the narrow interface — there's no filesystem or network surface in the runner
  module beyond the Anthropic client.

Target size: ~100 lines including imports and error mapping.

---

## 9. Gate logic

`gate.ts` is a pure function. Decision matrix:

| `event.action` | `issue.user.login` | Title starts with `[AI]` | Label state | `event.sender.login` | Decision |
| --- | --- | --- | --- | --- | --- |
| `opened` | `<allowed-actor>` | yes | (any) | n/a | `plan` |
| `opened` | `<allowed-actor>` | no | (any) | n/a | `ignore` |
| `opened` | anyone else | (any) | (any) | n/a | `ignore` |
| `labeled` | (any) | (any) | added label is `ai:plan` | in `MAINTAINERS` | `plan` |
| `labeled` | (any) | (any) | added label is `ai:implement` | in `MAINTAINERS` | `implement` |
| `labeled` | (any) | (any) | added label is `ai:plan` / `ai:implement` | NOT in `MAINTAINERS` | `ignore` |
| `labeled` | (any) | (any) | added label is anything else | (any) | `ignore` |

Notes:
- For `labeled` events, the gate inspects `event.label.name` (the label just added),
  not the issue's full label set — this is what GitHub's webhook gives us.
- `<allowed-actor>`'s `[AI]` issues do **not** auto-route to `implement` even if they carry
  the `ai:implement` label on first open. Implement mode is Phase 2; for now it
  short-circuits to a "deferred" log entry. When Phase 2 lands, the gate row for
  `opened` will be extended.
- The denial reason is always recorded in the step summary for debugging.

---

## 10. Configuration

Centralized so swaps are one-file edits.

**`config/allowed-actors.ts`** — env-driven so the OSS repo doesn't ship
a specific GitHub handle. Set `SHARKCRAFT_AI_ALLOWED_ACTORS` to a
comma-separated list in the repo's Actions variables.
```ts
export function getAllowedActors(): readonly string[] {
  const raw = process.env['SHARKCRAFT_AI_ALLOWED_ACTORS'] ?? '';
  return raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}
```

**`config/maintainers.ts`** — same env-driven shape via `SHARKCRAFT_AI_MAINTAINERS`.
```ts
export function getMaintainers(): readonly string[] {
  const raw = process.env['SHARKCRAFT_AI_MAINTAINERS'] ?? '';
  return raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}
```

**`config/labels.ts`**
```ts
export const LABELS = {
  plan: 'ai:plan',
  implement: 'ai:implement',
} as const;
```

**`config/model.ts`**
```ts
export const MODEL_ID = 'claude-opus-4-7' as const;
// Pinned. Bumps go through normal PR review. No env override in Phase 1.
```

**`config/limits.ts`**
```ts
export const LIMITS = {
  // Sanitization
  maxIssueTitleBytes: 512,
  maxIssueBodyBytes: 16 * 1024,         // 16 KB pre-sanitize cap
  maxShrkContextBytes: 64 * 1024,       // 64 KB cap on shrk task output

  // Runner
  maxInputTokens: 150_000,              // pre-call estimate hard cap
  maxOutputTokens: 8_192,
  runnerDeadlineMs: 10 * 60 * 1000,     // 10 min — workflow timeout is 15 min outer

  // shrk subprocess
  shrkTaskTimeoutMs: 60 * 1000,
} as const;
```

---

## 11. Sanitization rules

`sanitize.ts` is a pure function. Order of operations:

1. **Byte caps:** truncate `title` at `LIMITS.maxIssueTitleBytes`, `body` at
   `LIMITS.maxIssueBodyBytes`. Truncation marker: ` …[truncated]`.
2. **Control characters:** strip everything in `\x00-\x08\x0B\x0C\x0E-\x1F\x7F`.
   Keep `\n` (`\x0A`) and `\t` (`\x09`).
3. **Zero-width / BiDi:** strip `​`-`‏`, `‪`-`‮`, `⁦`-`⁩`.
   These are common prompt-injection vectors.
4. **Code fence neutralization:** the issue body will be embedded inside a fenced
   block in the prompt. Replace any standalone ` ``` ` openings with ` \`\`\` ` to
   prevent breakouts. Pick a unique fence (e.g., 6 backticks) for the wrapping fence
   in `plan.md` so simple triple-backtick content can't escape.
5. **Label the data:** the sanitized output is wrapped in clear delimiters
   (e.g., `<issue-data>...</issue-data>`) and the system prompt explicitly tells
   the model that anything inside those delimiters is untrusted user data.

Sanitization is a one-way transform: it never decodes, never executes, never URL-fetches.

---

## 12. Telemetry

Compact and identical in both sinks. Captured fields:

| Field | Source |
| --- | --- |
| `mode` | gate result (`plan` since failure comments only post post-gate) |
| `model` | `output.telemetry.modelId` |
| `runUrl` | `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}` |
| `tokens` | `output.telemetry.inputTokens + output.telemetry.outputTokens` (or `—` if null) |

**Step summary** (`$GITHUB_STEP_SUMMARY`): a compact key/value table.

**Comment footer:** appended at the bottom of the posted comment as a fenced block:

```
---
mode: plan | model: claude-opus-4-7 | tokens: ~12,340 | run: <url>
```

Implementation lives in `src/telemetry.ts` so the two views can't drift.

---

## 13. Failure handling

`errors.ts` exports an `ErrorCategory` enum and a `classify(err): ErrorCategory`
function. Categories — initial set, kept stable so log search remains useful:

```ts
export enum ErrorCategory {
  ContextCollectionFailed = 'context_collection_failed',
  RunnerTokenLimit        = 'runner_token_limit',
  RunnerTimeout           = 'runner_timeout',
  RunnerApiError          = 'runner_api_error',
  CommentPostFailed       = 'comment_post_failed',
  UnknownError            = 'unknown_error',
}
```

**On post-gate failure:**
1. Classify the error.
2. Post a short comment to the issue containing only: failed `mode`, `category`,
   `runUrl`. No stack traces, no message text, no log dumps.
3. Log full error + stack to `console.error` (visible in Actions logs).
4. Exit non-zero so the Actions run is marked failed.

**Special case:** if `category === CommentPostFailed`, posting a follow-up comment
will also fail. Log, write the failure to `$GITHUB_STEP_SUMMARY`, exit non-zero.

**Pre-gate failure** (event parse, gate exception): no comment, log only, exit non-zero.
Random users should never see noise from runs that weren't authorized to act.

---

## 14. Comment format

Plan-mode comment template (the runner fills in the body; orchestration appends the footer):

```markdown
## AI Plan

**Summary**
<one-paragraph restatement of the issue>

**Approach**
<numbered steps, high-level>

**Files likely to change**
- `path/to/file.ts` — <why>
- ...

**Risks & assumptions**
- <bullet>

**Open questions**
- <bullet>

---
mode: plan | model: claude-opus-4-7 | tokens: ~12,340 | run: https://github.com/.../actions/runs/12345
```

Failure-mode comment template:

```markdown
## AI Run Failed

The agent could not complete the requested mode.

- mode: plan
- category: runner_timeout
- run: https://github.com/.../actions/runs/12345

See the Actions logs for details.
```

---

## 15. Safety contracts

**Input handling:**
- Issue title, body, and (later) comments are untrusted data, not instructions.
- The system prompt explicitly declares this and instructs the model to **report**
  injection attempts in the "Open questions" section rather than follow them.
- Sanitization (§11) is the structural defense; the prompt declaration is the
  semantic defense. We use both.

**Workflow guardrails:**
- `permissions: read-all` at workflow level; per-job escalation to the minimum needed.
- No `pull_request_target`. No reusable workflows that inherit caller secrets.
- `GITHUB_TOKEN` only — no PAT. `ANTHROPIC_API_KEY` is the sole external secret.
- The runner module has no filesystem write capability, no git capability, no
  GitHub API capability. These are orchestration concerns and stay there.

**Concurrency & abuse:**
- Per-issue concurrency group → one run per issue at a time.
- Outer workflow timeout (15 min) caps cost in the failure case.
- Inner runner deadline (10 min) gives the orchestrator room to post a failure
  comment before the workflow hard-stops.
- Token caps (input + output) cap cost on the success case.
- Pre-gate denials never post anything, eliminating the trivial spam vector.

**Forbidden in Phase 1 — enforced by code review (no automation needed since
Phase 1 has no write capability):**
- No edits to `.github/workflows/**`.
- No edits to `tools/ai-agent/**`.
- No `publish`, no `release`, no tagging, no main branch operations.

**Phase 2 will add code-level enforcement** for the implement runner; Phase 1
relies on the runner having no write surface.

---

## 16. Phase 2 sketch (not implemented)

Documented here only to confirm Phase 1 doesn't lock us out:

- `IAgentRunOutput` gains optional `changes?: IProposedChange[]`. Additive — Phase 1
  ignores any unexpected fields.
- `orchestrate.ts` gains an `applyChanges` step gated on
  `mode === Implement && output.changes?.length > 0`. Phase 1 path untouched.
- New module `src/validate-changes.ts` runs **before** any commit:
  - Forbidden paths check (`.github/workflows/**`, `tools/ai-agent/**`, secrets, etc.).
  - `bun run typecheck`, `bun test`, `bun run lint`.
  - `shrk doctor`, `shrk check boundaries`.
  - Refuses commit on any failure.
- New module `src/git-ops.ts`:
  - Creates `ai/issue-<num>-<slug>` branch from `main`.
  - Commits with `[AI] <title>` and `Refs: #<num>` trailer.
  - Pushes branch. Never to `main`.
  - Forbidden commands: `npm publish`, `bun publish`, `git push origin main`,
    `git push --force`, `git tag`, `gh release create`.
- New module `src/open-pr.ts`: opens PR back to `main`, `[AI]` title prefix,
  description links the issue and the workflow run.
- Workflow job-level permissions grow `contents: write` and `pull-requests: write`.
  This is the only workflow change needed for Phase 2.
- New runner implementation (`advanced-runner.ts` or similar) implements the same
  `IAgentRunner` interface, returning both `commentMarkdown` and `changes`.

None of the above is built in Phase 1. The Phase 1 interface and orchestration
are designed so this all lands as additive changes.

---

## 17. Test plan

Phase 1 tests, all in `tools/ai-agent/__tests__/`:

**`gate.test.ts`** — exhaustive decision matrix:
- `<allowed-actor>` + `[AI]` title + `opened` -> `plan`.
- `<allowed-actor>` + non-`[AI]` title + `opened` -> `ignore`.
- Random user + any title + `opened` -> `ignore`.
- `labeled` with `ai:plan` by maintainer -> `plan`.
- `labeled` with `ai:implement` by maintainer -> `implement`.
- `labeled` with `ai:plan` by non-maintainer -> `ignore`.
- `labeled` with `ai:plan` by maintainer on issue from random user -> `plan`.
- `labeled` with unrelated label -> `ignore`.
- Each row asserts the denial reason string for traceability.

**`sanitize.test.ts`** — adversarial inputs:
- Title and body exceeding byte caps -> truncated with marker.
- Control characters stripped.
- Zero-width / BiDi characters stripped.
- Backtick fence breakouts neutralized.
- Plain UTF-8 content preserved.
- Sample known prompt-injection strings ("ignore previous instructions...") pass
  through unchanged but are wrapped in untrusted-data delimiters; test asserts
  the wrapping, not the content.

**`orchestrate.test.ts`** — uses a fake `IAgentRunner`:
- Happy path: gate returns `plan`, fake runner returns markdown, comment posted.
- Runner throws `AbortError` -> failure comment with `runner_timeout`.
- Runner throws SDK-like error -> failure comment with `runner_api_error`.
- Comment post throws -> step-summary records `comment_post_failed`, no double-post.
- `gate` returns `ignore` -> no comment, no runner call, exit 0.
- `gate` returns `implement` -> no comment, no runner call, exit 0.
- Telemetry block present in both step summary and comment footer.

**`claude-plan-runner.test.ts`** — Anthropic SDK mocked:
- Returns markdown from `messages.create`.
- Maps `usage.input_tokens` / `usage.output_tokens` to telemetry.
- Pre-call token estimate > cap -> throws with category-mappable message.
- Aborts on signal -> throws `AbortError`.

**What we do not test in Phase 1:**
- End-to-end GitHub Actions integration. Verified manually on a throwaway repo
  before merging.
- Real Anthropic API calls. Manual smoke test post-merge.

---

## 18. Acceptance criteria for Phase 1

Ship Phase 1 when **all** are true:

1. `.github/workflows/ai-issue.yml` exists, ~25 lines, matches §5.
2. `tools/ai-agent/run.ts` exists and is the only thing the workflow invokes.
3. `IAgentRunner` is the sole point of variation between current and future runners.
4. `bun test tools/ai-agent` passes (gate, sanitize, orchestrate, claude-plan-runner).
5. `bun x tsc -p tsconfig.base.json --noEmit` passes for the new modules.
6. `shrk check boundaries` passes (no cross-layer imports from `tools/ai-agent/`
   into `packages/*` source).
7. Manual smoke test on a throwaway repo:
   - `<allowed-actor>` opens issue titled `[AI] hello` -> plan comment appears within 5 min.
   - Random user opens issue titled `[AI] hello` -> no comment, no runner call.
   - Maintainer adds `ai:plan` label to a random user's issue -> plan comment appears.
   - Random user self-applies `ai:plan` label -> no comment.
   - Issue titled `[AI] hello` with `ai:implement` -> step summary says "deferred",
     no comment.
8. CI (`ci.yml`) is unchanged. Diff against `main` shows zero edits to it.

---

## 19. Implementation order

When implementation begins (separate PR; this plan stays read-only):

1. Add `tools/ai-agent/src/runner/types.ts`, `config/*.ts`, `errors.ts`,
   `telemetry.ts`. No behavior yet.
2. Add `gate.ts` + `gate.test.ts`. Green.
3. Add `sanitize.ts` + `sanitize.test.ts`. Green.
4. Add `context.ts` (shells `shrk task`). Smoke-test against local repo.
5. Add `github.ts` (post comment). Smoke-test against a sandbox issue.
6. Add `runner/claude-plan-runner.ts` + `runner/factory.ts` + tests with SDK mocked.
7. Add `orchestrate.ts` + `orchestrate.test.ts` using a fake runner.
8. Add `run.ts` entrypoint. Wire env reading.
9. Add `prompts/system.md` + `prompts/plan.md`.
10. Add `.github/workflows/ai-issue.yml`. Push branch (not main), test on issues
    in a throwaway repo / fork, verify §18 #7 cases.
11. Open PR. Existing `ci.yml` validates the diff. Merge after review.

Phase 2 is a separate PR after Phase 1 has been used in anger for a while.

---

## 20. Decisions locked

For traceability — these are not re-litigated:

- Triggers: `issues.types: [opened, labeled]`. No `edited`, `reopened`, `issue_comment`.
- Gate: `<allowed-actor>` + `[AI]` opened -> plan; others opened -> ignore; `ai:plan` by
  maintainer -> plan; `ai:implement` -> Phase 2 stub only.
- Maintainer check: explicit allowlist in `config/maintainers.ts`.
- Comments: append one new comment per run. No sticky-comment. No label cleanup.
- Runtime: Bun + Anthropic SDK. No third-party Action handles secrets.
- Model: pinned in `config/model.ts`. Bumps via PR. No env override yet.
- Telemetry: written to both `$GITHUB_STEP_SUMMARY` and the comment footer.
  Fields: mode, model, runUrl, approximate tokens.
- Failure comments: post-gate failures get a short comment (mode + category + runUrl).
  Pre-gate failures stay in logs only. No stack traces in comments.
- Caps: 16 KB issue body, 64 KB shrk context, 150K input tokens, 8K output tokens,
  10 min runner deadline, 15 min workflow timeout.
- Existing `ci.yml` is untouched and remains the sole validator for AI-authored PRs
  (Phase 2 onward).
