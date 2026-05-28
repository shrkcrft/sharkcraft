# `shrk smart-context` — Gemini-backed enriched briefs & multi-task pre-planning

This skill teaches Codex (or any agent that loads `.Codex/skills/*`)
how to use `shrk smart-context` to get richer, repository-grounded
context before — and during — multi-task work. It's the opt-in AI lens
that sits on top of SharkCraft's deterministic engine.

If the user's request is a *single, scoped* implementation change in
this repo, use the `sharkcraft-dev` skill instead. `smart-context` is
the right move when you need:

- a denser, AI-synthesised brief before starting (more prose than
  `shrk context` / `shrk brief` give you), **or**
- pre-baked plans for a *list* of upcoming tasks so later turns are
  cheap, **or**
- a structured plan (file paths, rules, steps, gotchas) you can act on
  step by step.

## What it sends to Gemini

The seed Gemini sees is:

1. **`AGENTS.md`** (auto-included if present at the repo root) — the
   repository's own agent instructions. This is the user's primary
   knob: editing `AGENTS.md` directly changes what Gemini gets. Use
   `--instructions <path>` to point at a different file, or
   `--no-instructions` to omit.
2. **Project overview** — workspace + framework summary.
3. **Top-ranked rules / paths / templates / commands** for the task
   (from `buildTaskPacket`).
4. **Knowledge-context body** — the same payload `shrk context`
   produces, capped at `--seed-tokens` (default 3500).

It does **not** read source files. If a particular task needs file
bodies, run `--dry-run` first, append them yourself, and call Gemini
directly. Don't add file-slurping to this skill — it blows the token
budget fast.

## Single-task usage

```bash
# Brief — quick orientation Markdown, fits in your context window.
shrk smart-context "<task>"

# Plan — JSON plan + Markdown summary, with file paths and steps.
shrk smart-context "<task>" --plan

# Save the output under .sharkcraft/smart-context/ so a later turn can read it.
shrk smart-context "<task>" --plan --save

# Inspect the prompt without burning API quota.
shrk smart-context "<task>" --dry-run
```

## Multi-task pre-planning (the "plan ahead" pattern)

When the user gives you a list of tasks for the session:

1. **Pre-plan the whole queue upfront** in one shot:

   ```bash
   shrk smart-context plan-ahead \
     "add a new doctor check for circular deps" \
     "wire that check into the quality gate" \
     "document the check in docs/quality-gates.md"
   ```

   Each task is sent to Gemini sequentially; plans are written to
   `.sharkcraft/smart-context/<slug>-plan.{md,json}`. The CLI prints
   one line per task showing the saved path.

2. **Work the first task** using your normal tools. When you need the
   plan, read it with the regular `Read` tool — no extra Gemini calls.

3. **Before starting task N+1**, list what's queued:

   ```bash
   shrk smart-context list
   ```

   and read the relevant entry:

   ```bash
   shrk smart-context show <slug>
   ```

4. **If the user adds tasks mid-session**, run `plan-ahead` again with
   just the new ones. Saved entries are addressed by their slug, so
   reruns of the same task overwrite cleanly.

## When NOT to use `smart-context`

- **Single, narrow code changes** where `shrk context --task "<task>"`
  already gives you what you need. The deterministic command is
  cheaper, reproducible, and offline.
- **Apply / plan-review / boundary check flows.** Those stay
  deterministic — `smart-context` never edits files and never feeds
  into `shrk apply`.
- **Any MCP path.** The MCP server is read-only and AI-free; do not
  add `smart-context` to it.

## Don'ts

- Don't treat Gemini's output as ground truth. Verify rule IDs,
  template IDs, and file paths against the deterministic seed (visible
  in the `--json` envelope's `deterministic.*` keys).
- Don't run `plan-ahead` on more than ~10 tasks at once. Each is a
  paid Gemini call; if the user wants a 30-task plan, surface that as
  a confirmation question first.
- Don't omit `--save` on `plan-ahead`. The whole point is that later
  turns read from disk; without `--save` the plans would be lost.
- Don't add a new `sharkcraft.config.ts` field to configure this. The
  configuration surface is `AGENTS.md` + `--instructions` on purpose.
