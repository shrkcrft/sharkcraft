# AI readiness

`shrk doctor` reports a 0–100 **AI-readiness score** derived from the
project's SharkCraft setup. It's deterministic — same inputs, same score —
and is meant as a quick "is this repo ready for AI agents?" signal, not a
marketing number.

## Where to see it

```bash
shrk --cwd <repo> doctor
# …
# AI-readiness: 84 / 100 (good)
# Top recommendations:
#   • Add verificationCommands to safety/generation rules.
#   • Add a critical safety rule with writePolicy:"cli-only".
```

Through MCP:

```text
tools/call get_ai_readiness_report → { score, grade, dimensions, topRecommendations }
```

## Dimensions

| id | weight | what it checks |
|---|---:|---|
| `config` | 0.5 | `sharkcraft.config.ts` is present. |
| `knowledge` | 1.0 | Number of knowledge entries (caps at 30+). |
| `rules` | 1.0 | Number of rules. |
| `paths` | 0.8 | Path conventions. |
| `templates` | 0.8 | Templates registered. |
| `pipelines` | 0.8 | Pipelines defined. |
| `action-hints` | 1.2 | Fraction of entries that carry `actionHints`. |
| `verification` | 0.6 | At least one entry lists `verificationCommands`. |
| `forbidden` | 0.6 | At least one entry lists `forbiddenActions`. |
| `docs` | 0.4 | Number of markdown source files. |
| `doctor` | 1.0 | Doctor passes; warnings reduce the score. |
| `packs` | 0.4 | Pack discovery health (valid / invalid ratio). |
| `safety` | 1.0 | A flagship safety rule with `writePolicy: cli-only`. |
| `hint-quality` | 0.6 | Output of action-hint diagnostics (fewer warnings → higher score). |

## Grade thresholds

| Range | Grade |
|---|---|
| 85–100 | excellent |
| 70–84 | good |
| 50–69 | partial |
| 0–49 | poor |

## What "good" looks like

- Doctor passes (`Ready for AI-agent use. ✓`).
- A clear safety rule with `writePolicy: cli-only` (`generation.dry-run-by-default` or equivalent).
- Most critical/high rules carry `actionHints` (`commands`, `mcpTools`, `forbiddenActions`).
- Pipelines for the dominant workflows (feature-dev, safe-generation, etc.).
- Templates for the constructs you generate most often.

A complex monorepo's dogfood configuration scores **84/100 (good)** on this round.
The dogfood example app scores **61/100 (partial)** because many of its
rules don't carry action hints — exactly the kind of gap an AI-readiness
score should call out.

## What it deliberately does NOT measure

- Code quality of the underlying repo.
- Whether your test suite passes.
- Whether you have CI.
- Any external signal (no GitHub stars, no telemetry).

The score is purely about the repo's **SharkCraft setup** — knowledge
quality, action guidance, and safety posture. Improving the codebase doesn't
move this number; encoding more structured knowledge does.
