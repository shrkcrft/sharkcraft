# SharkCraft — public alpha

This page is the canonical "what is SharkCraft right now, and how do I try it"
guide. It is intentionally short. Drill-down docs are linked from each section.

## Thirty-second pitch

SharkCraft makes a repository **AI-operable without giving AI unsafe write
access**. The CLI is the only write path. Everything an agent can read is also
human-runnable and reproducible.

## What's in the alpha

- A deterministic CLI surface (`shrk`) with 220+ commands.
- A read-only MCP server with parity tools.
- Knowledge / rules / paths / templates / pipelines / boundaries / packs.
- Bundle, brief, dev session, review, impact, report-site surfaces.
- Pack authoring + release-check + symbol compat + dist-aware mode.
- Demo package + release-smoke harness + release-readiness aggregator.
- Agent handoff packet + start-here flow + repository map.
- CI scaffolds for GitHub Actions, GitLab, Bitbucket, Jenkins, Azure DevOps,
  with a permissions audit and a fix-preview generator.

## Safety pledge

- MCP tools never write.
- The dashboard server is GET/HEAD only.
- `shrk gen` is dry-run by default; `apply` requires `--verify-signature`.
- Pack-contributed verification commands are NOT auto-run.
- Demo scripts refuse to emit destructive commands.

## Try it in five minutes

```bash
# 1. See what to do first.
shrk start-here

# 2. Doctor + repository map.
shrk doctor
shrk architecture map

# 3. Pick a flow.
shrk commands primary

# 4. Build a brief for an agent.
shrk brief "your first task"

# 5. Before tagging.
shrk release readiness --strict --preflight auto
```

## Smoke-test it locally

```bash
shrk release smoke --scenario all --report --html
```

Runs five canonical scenarios against temp fixtures, asserts no writes leak
outside `.sharkcraft/`, and emits `release-smoke.{json,md,html}`.

## Drill down

- `docs/start-here.md` — primary flows and recommended commands.
- `docs/safety-model.md` — the full safety contract.
- `docs/onboarding.md` — bring SharkCraft into an existing repo.
- `docs/release-readiness.md` — the release gate.
- `docs/demo-package.md` — the demo package (now with `--validate`).
- `docs/agent-handoff.md` — continue-from-here packets.
- `docs/repository-map.md` — the structural map.
- `docs/ci-permissions.md` — workflow audit + fix preview.
- `docs/adoption-checkpoints.md` — checkpoint statuses (now age-aware).

## Known limitations

See the matching section of `development/feature_16.md` and the per-doc files.
