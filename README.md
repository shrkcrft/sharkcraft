# SharkCraft

> **Structured project intelligence for AI coding agents.**

SharkCraft does **not** replace AI coding agents like Claude Code, Cursor,
or Aider. It makes repositories understandable and safer for them. Encode
your project's rules, paths, templates, architecture facts, and AI
workflows as typed entries — then serve them through a CLI for humans and
an MCP server for agents.

| | Coding agents (Claude Code / Cursor / Aider) | SharkCraft |
|---|---|---|
| Writes code | Yes | No (MCP), CLI only |
| Reads everything in the repo | Yes (window-bounded) | Only the relevant slice per task |
| Conventions awareness | From context dump | From typed rules + path conventions |
| Generation safety | Up to the agent | Plan-first, dry-run by default, signed plans |
| Workflow guidance | Ad-hoc | Declarative pipelines |

> Status: **0.1.0-alpha.2**. APIs may shift. Bun ≥ 1.1 is the primary runtime.
> Release notes: [`docs/releases/0.1.0-alpha.2.md`](docs/releases/0.1.0-alpha.2.md) ·
> known limitations: [`docs/public-alpha-limitations.md`](docs/public-alpha-limitations.md) ·
> external quickstart: [`docs/external-repo-quickstart.md`](docs/external-repo-quickstart.md).

## Try it in 30 seconds

```bash
# Once published (Bun):
bunx @shrkcrft/cli@alpha init                       # scaffold sharkcraft/ (preset = generic)
bunx @shrkcrft/cli@alpha init --preset bun-service  # or pick a tailored preset
bunx @shrkcrft/cli@alpha doctor                     # ready-for-AI verdict + 0..100 score
bunx @shrkcrft/cli@alpha task "generate a service"  # AI-ready task packet
bunx @shrkcrft/cli@alpha mcp serve                  # start the MCP server (stdio)

# Or via the unscoped `shrk` package — same surface, same flags, npm/yarn/pnpm friendly:
npx shrk@alpha init
npx shrk@alpha doctor
npx shrk@alpha task "generate a service"
```

### Try it in 60 seconds — adoption floor

For any TypeScript repo, even with no `sharkcraft/` folder yet:

```bash
shrk inspect                                          # Detected block: pm, frameworks, configs, recommended preset
shrk init --zero-config                               # preview the auto-picked preset (dry-run)
shrk init --zero-config --write                       # persist the preset
shrk ci scaffold github-actions --quickstart --write  # one-flag CI (doctor + changed-only boundaries + conditional gates)
shrk eslint scaffold                                  # bridge to existing ESLint
shrk checks aggregate                                 # universal rollup of SharkCraft + ESLint + Biome + custom checks
```

Detailed: [`docs/zero-config-init.md`](docs/zero-config-init.md),
[`docs/presets.md`](docs/presets.md),
[`docs/github-action.md`](docs/github-action.md),
[`docs/eslint-bridge.md`](docs/eslint-bridge.md),
[`docs/biome-bridge.md`](docs/biome-bridge.md),
[`docs/check-result-protocol.md`](docs/check-result-protocol.md).

## Architecture intelligence

SharkCraft also detects when a repository drifts from its own architecture:

- `shrk check boundaries` — forbidden-import scan
  ([`docs/boundaries.md`](docs/boundaries.md)).
- `shrk drift` — combined drift report
  ([`docs/drift.md`](docs/drift.md)).
- `shrk coverage` — relationship/coverage quality
  ([`docs/coverage.md`](docs/coverage.md)).
- `shrk graph` — knowledge graph (nodes + edges).
- `shrk review --since HEAD~1` — AI-ready PR review packet
  ([`docs/review-packets.md`](docs/review-packets.md)).
- `shrk test context|agent` — regression tests for retrieval + task packets
  ([`docs/context-tests.md`](docs/context-tests.md),
  [`docs/agent-contract-tests.md`](docs/agent-contract-tests.md)).
- `shrk plan review <plan.json>` + `shrk apply --validate`
  ([`docs/plan-review.md`](docs/plan-review.md)).
- `shrk dev start "<task>"` — full AI-safe development workflow
  (task → session → plan → review → apply → validate → report)
  ([`docs/dev-workflow.md`](docs/dev-workflow.md)).
- `shrk quality` — single-command quality gate (doctor / boundaries /
  coverage / tests / packs) ([`docs/quality-gates.md`](docs/quality-gates.md)).
- `shrk ci scaffold github-actions` — generate a starter SharkCraft CI
  workflow ([`docs/ci-scaffold.md`](docs/ci-scaffold.md)).
- `shrk packs new <name>` — scaffold a new SharkCraft pack package
  ([`docs/pack-authoring.md`](docs/pack-authoring.md)).
- `shrk onboard adopt` — safely classify and adopt inferred items
  ([`docs/onboarding-adoption.md`](docs/onboarding-adoption.md)).
- `shrk commands` — full CLI catalog with safety labels
  ([`docs/command-catalog.md`](docs/command-catalog.md)).
- `shrk safety audit` — deterministic safety model audit
  ([`docs/safety-model.md`](docs/safety-model.md)).
- `shrk commands doctor` — catalog completeness check
  ([`docs/command-catalog.md`](docs/command-catalog.md)).
- `shrk dev report <id> --html` and `shrk dev open <id> --serve --live`
  — local, self-contained HTML session view + SSE auto-refresh
  ([`docs/session-html-report.md`](docs/session-html-report.md)).
- `shrk onboard adopt status / regenerate / merge-preview / check / report`
  — adoption state model + freshness + safe regenerate + three-way preview
  ([`docs/onboarding-adoption.md`](docs/onboarding-adoption.md)).
- `shrk scaffolds list / get / doctor` — pack-contributed scaffold patterns
  ([`docs/scaffold-patterns.md`](docs/scaffold-patterns.md)).
- `shrk infer templates --ast` — TypeScript-AST template body inference v2
  ([`docs/inference.md`](docs/inference.md)).
- `shrk report adoption|session|quality|safety|review|coverage|drift|graph`
  — runtime report group, text / markdown / html / json
  ([`docs/reports.md`](docs/reports.md)).
- The dashboard is shipped as a standalone Vite app (`@shrkcrft/dashboard`);
  the read-only data path is the `get_dashboard_summary` MCP tool
  ([`docs/dashboard.md`](docs/dashboard.md),
  [`docs/dashboard-api.md`](docs/dashboard-api.md)).

## Daily workflow

Day-to-day, prefer the **dev workflow** — it guides the whole loop with
deterministic state transitions and a `session.json` audit trail:

1. `shrk dev start "<task>"` — create session, save task packet + context.
2. `shrk dev plan <id> --template <id> --name <name> --var k=v` — save a
   signed dry-run plan and auto-run plan review.
3. `shrk apply plans/<plan>.json --verify-signature` — the human-approval
   write step.
4. `shrk dev validate <id>` — run `sharkcraft.config` verifications + boundary check.
5. `shrk dev report <id>` — write the audit-trail `final-report.md`.

`shrk dev next <id>` always tells you the next safe command.

Lower-level commands the dev workflow composes:

- `shrk recommend "<task>"` — what should I do in this repo right now?
- `shrk task "<task>"` — bundle of context + commands + forbidden actions (machine / agent surface).
- `shrk pipelines script <id> --task "<task>"` — render runnable bash.
- `shrk gen <template> <name> --dry-run --save-plan p.json` — plan only.
- `shrk apply p.json` — single write path.

Other useful daily commands:

- `shrk search <query>` — unified search across knowledge / rules / paths /
  templates / pipelines / packs / presets / boundaries / docs / sessions /
  bundles / constructs / playbooks. ([docs/search.md](docs/search.md))
- `shrk impact <fileOrSpecifier>` — direct + transitive dependents, risk +
  suggested tests. `--format html|markdown|json --output <file>` writes
  a self-contained report. ([docs/impact.md](docs/impact.md))
- `shrk brief "<task>"` — one-shot Markdown agent brief; supports
  `--mode compact|full|review|implementation|handoff`.
  ([docs/brief.md](docs/brief.md))
- `shrk dev start "<task>" --brief` — start a session and drop `brief.md`
  inside it.
- `shrk constructs list / get / trace / api / events / tokens / facets / search / infer`
  — generic construct/facet inspection and auto-discovery.
  ([docs/constructs.md](docs/constructs.md))
- `shrk playbooks recommend "<task>"` / `shrk playbooks script <id>` /
  `shrk playbooks validate <id>` — match a task, render an annotated script,
  or validate references. ([docs/playbooks.md](docs/playbooks.md))
- `shrk bundle status / replay <id> / replay --all` — bundle progress and
  single-bundle or cross-bundle tamper / drift detection.
  ([docs/bundles.md](docs/bundles.md))
- `shrk policy test <id> --fixture <dir>` — policy-author harness.
  ([docs/policy-checks.md](docs/policy-checks.md))
- `shrk quality` / `shrk quality baseline diff|prune|history` — quality
  gate + baseline tooling; the `history` subcommand reports baseline runs and
  `diff` accepts the `latest` / `previous` aliases.
  ([docs/quality-baselines.md](docs/quality-baselines.md))
- `shrk report site --manifest` — JSON inventory of the static report site.
  ([docs/static-reports.md](docs/static-reports.md))
- `shrk explain <topic>` — compact local explanation, no AI required.
- `shrk check` — sweep doctor + knowledge + templates + pipelines + packs
  + action-hints; gate in CI with `--strict`.
- `shrk presets recommend` — rank presets against the detected project profile.

Until alpha-1 lands on npm, run from this repo with `bun run shrk ...`.

## CLI + MCP, two halves of the same surface

- **CLI (`shrk`)** — for humans. Token-budgeted context, dry-run generation,
  apply, doctor, exports, imports, pipelines, packs, plan/pack signing.
- **MCP server** — for agents. ~150 read-only tools and resources via
  `@modelcontextprotocol/sdk`. **The MCP server never writes files.**
  Generation goes through `shrk apply` on the CLI.

## What this gives an AI agent

Instead of dumping prose docs into the context window, an agent that reads
through SharkCraft sees:

- **`get_relevant_context`** — only the rules / paths / facts that match the
  current task, filtered by `appliesWhen` / `scope` / `tags` / `priority`,
  budgeted by token count.
- **`get_action_hints`** — for each high-priority rule, the exact CLI
  commands, MCP tools, forbidden actions, verification commands, and write
  policy the agent should follow.
- **`list_pipelines` / `get_pipeline_context`** — declarative workflows the
  agent walks step by step (gather context → generate plan → apply via CLI).
- **`create_generation_plan`** — dry-run code generation. The MCP server
  **never** writes files; the human applies the plan via `shrk apply`.
- **`get_ai_readiness_report`** — 0–100 weighted score so the agent
  (and CI) can see whether the repo is "agent-ready" yet.

## 5-minute quickstart

```bash
# 1. Install + verify
bun install
bun run typecheck
bun test                                                # ~1700 tests

# 2. Walk the dogfood example end-to-end
bun run shrk --cwd examples/dogfood-target doctor
bun run shrk --cwd examples/dogfood-target context --task "generate a user profile service"
bun run shrk --cwd examples/dogfood-target pipelines list
bun run shrk --cwd examples/dogfood-target export agents-md  # dry-run preview

# 3. Try the safe-write flow (CLI is the only write path)
bun run shrk --cwd examples/dogfood-target gen typescript.service demo \
  --var className=DemoService --dry-run --save-plan /tmp/p.json
bun run shrk --cwd examples/dogfood-target apply /tmp/p.json
```

## Quick demo

The canonical demo flows live under [`examples/dogfood-target/`](examples/dogfood-target/) —
read the README there and run the example scripts to reproduce the
onboarding / PR-review / governance walkthroughs. The `shrk demo` namespace
was retired in favour of in-repo example scripts; demo content belongs in
code, not the CLI.

## Runnable PR-review workflows

For multi-stage CI scaffolds:

```bash
shrk ci scaffold gitlab    --with-quality --with-policy --with-impact --with-report-site
shrk ci scaffold bitbucket --with-quality --with-policy --with-impact --with-report-site
```

## Adoption parity

Both adoption surfaces now expose a line-level diff against the live
config — no patches written, no source files touched:

```bash
shrk onboard adopt diff --format markdown
shrk constructs adopt diff --format markdown
```

Pack release readiness is one command instead of two:

```bash
shrk packs doctor --release --require-signatures        # release-check folded in
```

## Release readiness

```bash
shrk release readiness --strict
```

`shrk release readiness` aggregates doctor + coverage + packs +
release-check + docs + README + `package.json` metadata into a single
verdict. `--strict` escalates warnings to blockers.

Optional SVG rendering is available for impact graphs
(`shrk report site --render-impact-graphs`), plugin-api symbol diff for
packs (`shrk packs compat --consumer-root <path>`), bundle-vs-bundle
diff (`shrk bundle diff a b`), CI permissions audit
(`shrk ci permissions <file>`), and adoption checkpoints
(`shrk onboard adopt diff --record-checkpoint`). The secondary Jenkins /
Azure CI scaffolds were retired — keep GitHub Actions first-class. See
`docs/release-readiness.md` for the full readiness gate.

## Public alpha

The public alpha ships a human entry point, a smoke harness, an agent
handoff packet, and a repository map. The standalone `map` / `handoff` /
`demo package` commands have since been folded into more canonical
entrypoints.

```bash
# Human entry point — 30-second tour + 5 primary flows + safety pledge.
shrk start-here
shrk commands

# Repository map — folded into `architecture map`.
shrk architecture map

# Continue-from-here packet for an agent — `brief` is canonical now.
shrk brief "<task>" --session <id>             # or --bundle <id>

# Smoke-test the canonical scenarios locally.
shrk release smoke --scenario all --report --html

# Release readiness — auto-discover the newest preflight, emit HTML.
shrk release readiness --strict --preflight auto --html --report

# Verify docs / examples on their own.
shrk docs check
shrk examples check

# Self-dogfood audit (only meaningful inside the SharkCraft repo).
shrk self audit

# Install smoke (verify the installed CLI surface).
shrk install smoke

# CI permissions fix preview (suggest the least-privilege diff).
shrk ci permissions <workflow> --fix-preview --format patch

# Pack compat — dist-aware mode (scan dist/*.js patterns too).
shrk packs compat <path> --consumer-root <consumer> --dist-aware

# Bundle diff — now detects renamed plans automatically.
shrk bundle diff <a> <b>
```

Public-alpha docs: [`docs/public-alpha.md`](docs/public-alpha.md),
[`docs/start-here.md`](docs/start-here.md),
[`docs/brief.md`](docs/brief.md),
[`docs/release-smoke.md`](docs/release-smoke.md).

## Onboard an existing repo

Point SharkCraft at a repo and get an advisory onboarding plan in seconds:

```bash
# Dry-run (default): print the plan, write nothing.
bun run shrk --cwd examples/unconfigured-bun-service onboard

# Materialize advisory drafts under sharkcraft/onboarding/
bun run shrk --cwd examples/unconfigured-bun-service onboard --write-drafts

# Same, but also draft *runnable* template bodies (services/utils/tests/components).
bun run shrk --cwd examples/unconfigured-bun-service onboard --write-drafts --scaffold-templates

# Same, but also parse AGENTS.md / CLAUDE.md / .cursor/rules into an imported-agent-rules draft.
bun run shrk --cwd examples/unconfigured-bun-service onboard --write-drafts --import-agents

# Compare the inferred plan against the live SharkCraft config (no writes).
bun run shrk --cwd examples/unconfigured-bun-service onboard --diff

# Monorepo (workspaces / Nx / apps+packages+libs layout).
bun run shrk --cwd examples/unconfigured-monorepo onboard --dry-run
```

The plan covers detected profiles, recommended presets, inferred rules /
path conventions / templates / boundary rules / pipelines, verification
commands lifted from `package.json`, and a readiness before/after estimate.
For monorepos, it also includes a per-package summary, per-package
verification hints, and boundary candidates derived from the layout.

Drafts are **advisory** — SharkCraft never overwrites `rules.ts`, `paths.ts`,
or `templates.ts`. See [docs/onboarding.md](./docs/onboarding.md).

### Render a PR review comment from a packet

```bash
bun run shrk review --since origin/main --json > review-packet.json
bun run shrk review render-comment review-packet.json --output review-comment.md
```

`render-comment` reads a review packet JSON and emits a Markdown PR comment
(summary, changed files, risks, boundary issues, suggested checks, reviewer
instructions). Wire it to `gh pr comment --body-file …` in your workflow. See
[docs/review-github-action.md](./docs/review-github-action.md).

## CLI quickstart

```bash
shrk --cwd ./my-repo init                                # generate scaffolding
shrk --cwd ./my-repo doctor                              # health + readiness
shrk --cwd ./my-repo doctor --strict --min-score 80      # CI gate
shrk --cwd ./my-repo context --task "..." --max-tokens 3000
shrk --cwd ./my-repo rules relevant --task "..."
shrk --cwd ./my-repo templates list
shrk --cwd ./my-repo gen typescript.service user-profile --dry-run
shrk --cwd ./my-repo gen typescript.service user-profile --write
```

`shrk doctor` ends with a clear verdict: **"Ready for AI-agent use. ✓"** or a
list of fixes. Pair with `--strict` (warnings fail) and `--min-score N`
(readiness gate) in CI.

## MCP quickstart

```bash
# Stdio (default — for Claude Code & similar)
bun run mcp                                              # uses $PWD
SHARKCRAFT_PROJECT_ROOT=/path/to/repo bun run mcp        # explicit target
bun run shrk -- --cwd /path/to/repo mcp serve --watch    # hot reload

# HTTP / Streamable HTTP (for shared / remote use)
bun run shrk -- --cwd /path/to/repo mcp serve --http --port 4000
curl http://localhost:4000/healthz
```

The server speaks both stdio and Streamable HTTP via
`@modelcontextprotocol/sdk`. It exposes ~150 tools (context, rules, paths,
templates, pipelines, packs, action hints, AI-readiness, plan creation) and
resources for knowledge / templates / docs. **It never writes files.**

See [`docs/mcp.md`](docs/mcp.md) for the full tool table,
[`docs/mcp-dashboard-summary.md`](docs/mcp-dashboard-summary.md) for the
one-call workspace summary shape, and
[`docs/claude-code.md`](docs/claude-code.md) for a copy-paste MCP config.

## Pipeline quickstart

```bash
shrk pipelines list                                  # available workflows
shrk pipelines get engine.feature-dev                # one workflow
shrk pipelines script engine.feature-dev \
  --task "generate a user profile service"          # copy-pasteable bash
shrk pipelines next engine.feature-dev --task "..." # what's next?
shrk pipeline list                                   # alias for pipelines
```

Pipelines are **declarative** — SharkCraft does not execute them. They tell
the agent or the human what to do, in which order, with which tools. Apply
or write steps include a manual-confirm prompt.

## Pack quickstart

A **pack** is an npm package that ships SharkCraft knowledge / rules /
templates / pipelines. To make a package a pack, add a `sharkcraft` field to
its `package.json` and ship a manifest:

```json
{
  "name": "@yourscope/your-pack",
  "main": "./src/sharkcraft.plugin.ts",
  "sharkcraft": { "manifest": "./src/sharkcraft.plugin.ts" }
}
```

```ts
// src/sharkcraft.plugin.ts
import { definePackManifest } from '@shrkcrft/plugin-api';
export default definePackManifest({
  schema: 'sharkcraft.pack/v1',
  info: { name: '@yourscope/your-pack', version: '0.1.0' },
  contributions: {
    knowledgeFiles: ['./assets/knowledge.ts'],
    templateFiles: ['./assets/templates.ts'],
    pipelineFiles: ['./assets/pipelines.ts'],
  },
});
```

Consumer repos install the pack normally; SharkCraft discovers it
automatically. Local entries always win on duplicate ids.

```bash
shrk --cwd ./your-repo packs list      # discovered packs (files + resolved)
shrk --cwd ./your-repo packs get @yourscope/your-pack
shrk --cwd ./your-repo packs doctor    # quality checks (templates, pipelines, hints, dups)
shrk --cwd ./your-repo packs doctor --require-signatures
shrk --cwd ./your-repo packs verify    # HMAC signature verification
```

Sign your pack with HMAC-SHA256 (optional, recommended for private packs):

```bash
export SHARKCRAFT_PACK_SECRET="$(openssl rand -hex 32)"
shrk packs sign ./your-pack \
  --key-id mykey-v1 \
  --verify-after-sign \
  --output ./your-pack/src/sharkcraft.plugin.signed.json
```

Then point `package.json` `sharkcraft.manifest` at the signed JSON — pack
discovery reads it as data (no dynamic import) and surfaces tamper detection.

## Signed-plan / safe-apply flow

```bash
export SHARKCRAFT_PLAN_SECRET="<a long random string>"

# 1. Agent or CLI creates a signed dry-run plan.
shrk gen typescript.service profile \
  --var className=ProfileService \
  --dry-run --sign --save-plan ./.sharkcraft/plans/profile.json

# 2. A human reviews ./.sharkcraft/plans/profile.json.

# 3. CLI applies the plan; signature is verified.
shrk apply ./.sharkcraft/plans/profile.json --verify-signature
```

- The MCP server never writes — it only returns plans.
- Plan signing is HMAC-SHA256 over canonical JSON (excluding the
  `signature` field). Any tampering — even a single byte — is detected.
- Without `SHARKCRAFT_PLAN_SECRET` the CLI refuses to verify signatures.

## Import existing agent rule files

Already have AGENTS.md, CLAUDE.md, or `.cursor/rules` lying around? Convert them
into structured knowledge drafts:

```bash
shrk import agents-md ./AGENTS.md                    # preview only
shrk import claude-md --prefix team --tag legacy --write
shrk import cursor-rules .cursor/rules --scope angular --scope typescript --write
```

Drafts land in `sharkcraft/imports/<format>-import.draft.ts`. Review them and
merge the entries you want into your live `sharkcraft/` config.

## Export to other agent rule formats

Generate compatibility files for tools that read flat markdown:

```bash
shrk export claude-md                # → CLAUDE.md (dry-run preview)
shrk export claude-md --write        # save it
shrk export cursor-rules --write     # .cursor/rules/sharkcraft.mdc
shrk export copilot-instructions --write
shrk export agents-md --write
```

The exports include the agent briefing, the high-priority rules, the action
hints, and a "what to do first" pointer to the MCP tools.

## A more complex flow: layered plugin architecture

This is the kind of workflow SharkCraft is built for — a deeply layered
codebase where an agent must obey ordering, layer boundaries, and "do not
duplicate framework-specific defaults" rules. An adopter pack ships the
project's knowledge base, pipelines, and templates so a single `shrk`
session can plan a feature end-to-end.

```bash
shrk doctor                                         # baseline health
shrk pipelines list
shrk pipelines get engine.feature-dev
shrk pipelines script engine.feature-dev \
  --task "add a pagination plugin with a page-changed event" \
  > /tmp/plugin-script.sh

# The script tells the agent:
#  1. shrk context --task "..." --max-tokens 3500    # only the relevant rules
#  2. shrk rules get plugin.design-sequence          # canonical ordering
#  3. Define contracts in the API layer first
#  4. Implement framework-agnostic logic in the cross layer
#  5. Add minimal bindings in each UI binding
#  6. shrk gen <template-id> ... --dry-run --save-plan ...
#  7. Human reviews
#  8. shrk apply <plan> --verify-signature
#  9. shrk doctor --strict
```

Every step is declarative. Nothing in the agent's instructions tells it to
"go read 50 markdown files." It calls a few MCP tools, gets a small, typed
slice of the project's intelligence, and proceeds.

## CI gate

Use `doctor --strict --min-score` as a non-zero-exit gate to ensure the repo
stays agent-ready:

```yaml
# .github/workflows/sharkcraft-ai-ready.yml
name: SharkCraft AI-readiness
on: [push, pull_request]
jobs:
  doctor:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1
      - run: bun install
      - run: bunx shrk doctor --strict --min-score 75
```

## The problem

LLM coding agents drift the moment they leave the well-trodden parts of a
codebase. Today the only way to keep them aligned is to feed them every
convention up front — long markdown briefs, retrieved at random, blown into
the context window. Most of that is noise; the parts the agent actually
needs are buried.

## The solution

Encode your project's intelligence as **typed entries** instead of prose:

- **Rules** — coding/architecture/testing/security constraints.
- **Path conventions** — where things live (`src/services`, `src/utils`, …).
- **Templates** — typed code generators with variables and target paths.
- **Architecture & decisions** — high-priority facts agents must respect.
- **Pipelines** — declarative workflows that tell the agent the order.
- **Action hints** — per-rule commands / MCP tools / forbidden actions.
- **Packs** — distributable bundles of all of the above.

Then expose them as:

- The **`shrk` CLI** for humans (token-budgeted context, dry-run generation,
  doctor checks, plan signing).
- The **MCP server** for AI agents (~150 tools, `@modelcontextprotocol/sdk`).

Every retrieval is filtered and budgeted. Agents never need to read
everything.

## Why structured knowledge beats doc dumping

| | Doc dumping | SharkCraft |
|---|---|---|
| What the agent sees | Whole docs | Only the slice for the current task |
| Token cost | High, mostly noise | Bounded, deterministic |
| Traceability | "Was it in the brief?" | Each section lists its entry ids |
| Drift | Easy | Each rule has an id, source, and priority |
| Generation safety | Up to the agent | Plan-first, dry-run by default, paths refused outside root |
| Workflow guidance | Ad-hoc | Declarative pipelines with action hints |
| CI gate | None | `doctor --strict --min-score` |

## Requirements

- [Bun](https://bun.sh) `>= 1.1`

## Safety model

- **Generation is plan-first.** `shrk gen` defaults to dry-run; `--write`
  requires a clean plan with no conflicts.
- **Target paths must resolve inside the project root.** Absolute paths and
  `../` traversal are refused by a single chokepoint
  (`safeResolveTargetPath`).
- **Knowledge files are local, trusted project config** — same model as
  `vite.config.ts` or `eslint.config.js`. SharkCraft never loads remote
  knowledge. See [`docs/security.md`](docs/security.md) and
  [`docs/knowledge-loading.md`](docs/knowledge-loading.md).
- **MCP tool inputs are zod-validated** at the boundary. Malformed input
  returns a clean error, never a crash.
- **Plan signing** with HMAC-SHA256 + `SHARKCRAFT_PLAN_SECRET` lets you
  verify that the plan being applied is the plan the agent created.
- **`shrk doctor`** validates the whole setup (project, sharkcraft folder,
  config schema, duplicate ids, missing fields, action-hint quality,
  AI-readiness score).

## Packages

| Package | Responsibility |
|---|---|
| `@shrkcrft/core` | Result, errors, logger, FS, path utils (incl. `safeResolveTargetPath`) |
| `@shrkcrft/shared` | Shared internals reused across packages |
| `@shrkcrft/config` | sharkcraft.config.ts loader + zod schema |
| `@shrkcrft/workspace` | Project / framework / package-manager detection |
| `@shrkcrft/knowledge` | Structured entries + index + search + validation |
| `@shrkcrft/rules` / `paths` | Domain services over knowledge |
| `@shrkcrft/templates` | Templates + variable validation + rendering |
| `@shrkcrft/boundaries` | Boundary rules: detect forbidden imports across folder/package/layer boundaries |
| `@shrkcrft/presets` | Reusable project setups (knowledge/rules/paths/templates/pipelines/docs) applied via the CLI |
| `@shrkcrft/context` | Token-budgeted AI context builder |
| `@shrkcrft/ai` | AI provider abstraction: Claude HTTP + Claude CLI adapters |
| `@shrkcrft/generator` | Plan-first generation, conflict detection, plan signing |
| `@shrkcrft/importer` | Parse AGENTS.md / CLAUDE.md / `.cursor/rules` into structured knowledge entries |
| `@shrkcrft/inspector` | Project overview, doctor, AI-readiness scorer |
| `@shrkcrft/pipelines` | Pipeline definitions + script renderer |
| `@shrkcrft/packs` | Pack manifest model + discovery |
| `@shrkcrft/plugin-api` | Extension points |
| `@shrkcrft/mcp-server` | MCP server over `@modelcontextprotocol/sdk` |
| `@shrkcrft/cli` | `shrk` CLI — sole write path |
| `@shrkcrft/dashboard-api` | Versioned dashboard wire types (types-only) |
| `@shrkcrft/dashboard` | React + Vite read-only dashboard UI |

## Docs

- [`docs/overview.md`](docs/overview.md) — what SharkCraft is.
- [`docs/philosophy.md`](docs/philosophy.md) — why structured knowledge.
- [`docs/architecture.md`](docs/architecture.md) — packages and dependencies.
- [`docs/cli.md`](docs/cli.md) — every CLI command.
- [`docs/mcp.md`](docs/mcp.md) — every MCP tool.
- [`docs/dashboard.md`](docs/dashboard.md) — local read-only dashboard UI.
- [`docs/dashboard-api.md`](docs/dashboard-api.md) — dashboard API contract.
- [`docs/claude-code.md`](docs/claude-code.md) — Claude Code MCP config.
- [`docs/packs.md`](docs/packs.md) — pack manifest format.
- [`docs/pipelines.md`](docs/pipelines.md) — pipeline definitions.
- [`docs/action-hints.md`](docs/action-hints.md) — action hint model.
- [`docs/ai-readiness.md`](docs/ai-readiness.md) — readiness scoring.
- [`docs/agent-format-export.md`](docs/agent-format-export.md) — claude-md, cursor-rules, copilot, agents-md.
- [`docs/release-checklist.md`](docs/release-checklist.md) — v0.1-alpha release flow.
- [`docs/security.md`](docs/security.md) — safety model.
- [`docs/knowledge-loading.md`](docs/knowledge-loading.md) — trust model.
- [`docs/release.md`](docs/release.md) — alpha publish plan.
- [`docs/testing.md`](docs/testing.md) — bun test layout.
- [`docs/ai-agent-guide.md`](docs/ai-agent-guide.md) — agent-facing usage.
- [`docs/roadmap.md`](docs/roadmap.md) — what's next.

## License

MIT
