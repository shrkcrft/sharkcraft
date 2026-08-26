# SharkCraft

**Durable project context for AI coding agents — and mechanical gates that hold
the same line in CI.**

SharkCraft (`shrk`) turns your architecture rules into typed, versioned source.
From that one definition it briefs every agent your team uses *and* fails the
build when the boundary is crossed — so what Claude is told and what CI enforces
can never drift apart.

**No AI inside the engine.** Every output is a deterministic function of your
workspace and your rules. The agent uses the engine; the engine never calls a
model.

```bash
bun add -d @shrkcrft/cli        # or: npm i -D @shrkcrft/cli
shrk init                       # detects your stack, writes typed rules
shrk doctor                     # verify
```

---

## Why it exists

A markdown rules file is a suggestion. It has no build step, no type checker,
and no test — so it rots silently, and the first sign of trouble is an agent
confidently writing code that violates a convention the file still describes.

SharkCraft closes that loop:

| | Markdown rules file | SharkCraft |
|---|---|---|
| Loads rules into the agent's prompt | you write it by hand | generated from typed source |
| Multi-agent (Claude · Cursor · Copilot · Aider) | one file per format, by hand | one source → every format |
| Boundary enforcement | advisory | `shrk check boundaries` fails the build |
| Detects its own staleness | markdown rots silently | every rule reports what it matched |
| Per-task context | load everything | `shrk task "<task>"` returns only what matters |
| Guard rail for agent writes | agent writes directly | signed plans, reviewed and validated |

---

## Quick demo

The whole loop, on a real repo:

```bash
# 1 · Adopt — pick the entry point that matches your repo today
shrk init                              # fresh repo: infers rules from your layout
shrk import claude-md --write          # existing CLAUDE.md / AGENTS.md / .cursor/rules
shrk init --preset nx-monorepo         # framework-correct baseline (72 presets)

# 2 · Brief the agent — deterministic, scoped to the task
shrk task "add a pagination plugin with a page-changed event"

# 3 · Generate through the safe write path
shrk gen <template-id> Pagination --dry-run --save-plan ./plan.json
shrk plan review ./plan.json
shrk apply ./plan.json --verify-signature --validate

# 4 · Prove it before you finish
shrk finish                            # boundaries + wiring + policy + orphans → one verdict
```

`shrk init` also emits `.claude/skills/<name>/SKILL.md`, so every Claude Code
session in the repo loads your rules automatically — no MCP round-trip, no
`CLAUDE.md` to keep in sync.

Full walkthroughs live in [`examples/dogfood-target/`](examples/dogfood-target/).

---

## What it does

### Rules that brief the agent and gate the build

One typed definition in `sharkcraft/`, consumed by both halves.

```bash
shrk context --task "<task>"    # the rules relevant to this task, nothing else
shrk check boundaries           # forbidden imports, tsconfig-alias aware
shrk export claude-md --write   # also: cursor-rules, copilot-instructions, agents-md
```

See [`docs/rules-system.md`](docs/rules-system.md),
[`docs/boundaries.md`](docs/boundaries.md),
[`docs/agent-format-export.md`](docs/agent-format-export.md).

### Gates for the failures a green build can't see

Seven data-defined rule planes, declared in `sharkcraft.config.ts` and sharing
one extraction DSL. They catch the bugs that type-check cleanly: a handler
declared but never registered, a committed ledger that silently drifted, a
hand-edited generated file, an id cited in prose that no longer resolves.

```bash
shrk gates check                # every plane, one exit code
shrk gates coverage             # what each rule actually matched — a rule matching
                                # nothing is a bug in the rule, never a pass
shrk gates try --rule-file r.json   # dry-run a rule before committing it
```

See [`docs/gate-rules.md`](docs/gate-rules.md),
[`docs/extraction-dsl.md`](docs/extraction-dsl.md).

### A code graph the agent can query instead of grepping

Callers, impact, and cycles as `path:line` truth — barrel re-exports resolved,
freshness reported honestly.

```bash
shrk graph index
shrk graph callers <symbol>     # who actually references this
shrk graph impact <file>        # what breaks if I change it
shrk check orphans --since main # after a delete: surviving importers
```

See [`docs/code-intelligence.md`](docs/code-intelligence.md),
[`docs/impact-analysis.md`](docs/impact-analysis.md).

### Fewer tokens for the same information

Deterministic compression — no model in the loop, and every lossy pass is
reversible.

```bash
shrk compress ./big-output.json   # JSON→table, logs/diffs/search→signal
shrk expand <ccr-key>             # recover the original
```

See [`docs/compression.md`](docs/compression.md).

### Optional local-LLM briefs

`shrk smart-context` refines the deterministic brief with a **local** model
(Ollama or llama.cpp). Hosted providers are explicit opt-in and never in the
default chain. With no model reachable, every command still works against the
deterministic seed.

See [`docs/smart-context.md`](docs/smart-context.md).

---

## Onboard an existing repo

`shrk onboard` reads a repository that has never seen SharkCraft and proposes a
configuration — advisory by default, writing nothing until you ask.

```bash
shrk onboard --dry-run                  # print the plan
shrk onboard --write-drafts             # drafts under sharkcraft/onboarding/ only
shrk onboard --import-agents            # fold in CLAUDE.md / AGENTS.md / .cursor/rules
shrk onboard adopt diff --format markdown   # line-level diff vs the live config
```

Every run emits a confidence triage — what was adopted, what needs review, what
was dropped. `--write-drafts` writes only under `sharkcraft/onboarding/`; it
never touches `rules.ts`, `paths.ts`, or `templates.ts`.

See [`docs/onboarding.md`](docs/onboarding.md),
[`docs/onboarding-adoption.md`](docs/onboarding-adoption.md).

---

## Safety model

The guarantees are structural, not conventions:

- **The CLI is the only write path.** Every MCP tool is read-only, including
  onboarding, generation, and apply — they return the next command for a human
  to run.
- **Writes go through plan → review → apply.** `shrk apply` verifies the plan's
  HMAC signature and refuses on divergence unless explicitly overridden.
- **Packs cannot execute on your behalf.** Pack-contributed verification
  commands are never auto-run, and any pack-contributed rule carrying a shell
  command is dropped at the merge seam.
- **Deletion is guarded.** `shrk check orphans` reports surviving importers of
  a removed file or export before the break reaches CI.

```bash
shrk safety audit --deep      # audit the safety model itself
shrk commands                 # every command, with its READ / WRITE label
```

See [`docs/safety-model.md`](docs/safety-model.md),
[`docs/security.md`](docs/security.md).

---

## CLI and MCP

Two halves of one surface. The CLI writes; MCP only reads.

```bash
shrk <command>                # the write path and the full surface
bun run mcp                   # MCP server over stdio, for Claude Code
shrk dashboard                # local read-only dashboard on 127.0.0.1:4567
```

Point Claude Code at the MCP server for retrieval, and let it call the CLI for
anything that writes. See [`docs/mcp.md`](docs/mcp.md),
[`docs/claude-code.md`](docs/claude-code.md).

---

## Requirements

- **Bun ≥ 1.1** is the primary runtime; the published CLI also runs on
  Node ≥ 18.
- **TypeScript** projects are the primary target. Polyglot boundary support
  exists for Go, Java, Python, C#, Rust and others — see
  [`docs/languages.md`](docs/languages.md).

`0.1.0-alpha` — the CLI surface and config schema are still moving between
releases. Pin an exact version. See [`CHANGELOG.md`](CHANGELOG.md).

---

## Documentation

| Start here | |
|---|---|
| [`docs/overview.md`](docs/overview.md) | what SharkCraft is, and what it deliberately is not |
| [`docs/quick-start.md`](docs/quick-start.md) | first fifteen minutes |
| [`docs/philosophy.md`](docs/philosophy.md) | the non-negotiable design rules |
| [`docs/cli.md`](docs/cli.md) | the full command surface |

| Deeper | |
|---|---|
| [`docs/gate-rules.md`](docs/gate-rules.md) | the seven rule planes |
| [`docs/architecture.md`](docs/architecture.md) | package layout and layer order |
| [`docs/packs.md`](docs/packs.md) | distributing rules as signed packages |
| [`docs/troubleshooting.md`](docs/troubleshooting.md) | when something misbehaves |

---

## License

MIT. See [`LICENSE`](LICENSE).
