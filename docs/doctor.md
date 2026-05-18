# `shrk doctor` (and the R52 `--blockers` preset)

`shrk doctor` validates the local SharkCraft setup: config, knowledge,
templates, project. It's the first command an agent should run when
arriving in a new repo — `shrk doctor` exiting 0 means the workspace is
healthy enough for the rest of `shrk` to be deterministic.

## Quick reference

```bash
shrk doctor                          # full report (the default)
shrk doctor --blockers               # R52 — only must-fix findings (errors + blocker categories)
shrk doctor --blockers --json        # agent-friendly machine output
shrk doctor --strict=errors          # exit non-zero on errors only
shrk doctor --strict=warnings        # exit non-zero on errors + structural warnings (hint-quality excluded)
shrk doctor --strict=all             # exit non-zero on any finding (including hint-quality)
shrk doctor --focus errors,warnings-new --hide action-hint-quality
shrk doctor --explain-quality        # add the "why this matters" line per warning
shrk doctor --watch [--debounce N]   # re-run on every sharkcraft/ change
```

## `--blockers` — the agent-friendly "must-fix" view

Before R52, an agent that wanted "blockers only" had to compose:

```
shrk doctor --strict=errors --focus errors --hide action-hint-quality,known-noise
```

That worked but was fragile and easy to mis-spell. `--blockers` is the
canonical, named shape. Its exit code is the contract:

- **Exit 0** — no blockers remain.
- **Exit 1** — at least one blocker remains.

### Blocker definition

A finding is a blocker when:

- `severity = error`, OR
- `severity = warning` AND its category is one of:
  - `config-invalid` — `sharkcraft.config.ts` is malformed or contradicts itself.
  - `pack-signature-invalid` — a pack manifest's HMAC signature failed verification.
  - `plan-signature-divergent` — a saved plan's HMAC signature no longer matches its body.
  - `asset-load-failed` — a knowledge / template / pipeline file failed to import.

Everything else — `action-hint-quality`, advisory rules, `known-noise`
suppressions — is **NOT** a blocker. Those still surface in the default
`shrk doctor` output; `--blockers` just filters them out so an agent
sees only the things that prevent the next safe step.

### Composes with `--json` and `--watch`

```bash
shrk doctor --blockers --json
# { "exitCode": 0, "blockers": { "enabled": true, "count": 0, ... }, ... }

shrk doctor --blockers --watch
# re-renders the blockers view on every sharkcraft/ change
```

### Why not extend `--strict`?

`--strict` is about exit-code policy, not visibility. `--strict=errors`
already exists for "exit non-zero on errors only" — but it doesn't
change which findings print. `--blockers` is the visibility+exit-code
preset; the two flags are orthogonal and can compose.

## Mode lines

When `--blockers` is set, doctor prints a mode line at the top:

```
=== SharkCraft doctor ===
  target root        /path/to/repo
  sharkcraft folder  /path/to/repo/sharkcraft
  mode               blockers-only — errors + warnings in {config-invalid, pack-signature-invalid, ...}; excludes action-hint-quality, advisory-rule, known-noise
```

So a reader (or a CI log scraper) always knows which view they're looking at.

## Subcommands

- `shrk doctor suppress` — add an entry to `sharkcraft/doctor.suppressions.json`.
- `shrk doctor suppressions list|check` — review configured suppressions.
- `shrk doctor acknowledge` — typed suppression with a required reason + expiry.
- `shrk doctor acknowledgements list|check` — review acknowledgements.
- `shrk doctor --watch` — re-run on every change (R31 flag on the
  main `doctor` command; the separate `doctor watch` subcommand was
  retired in R54).

See [doctor-suppressions.md](./doctor-suppressions.md) and
[doctor-warning-quality.md](./doctor-warning-quality.md) for the
nuance.

## Related

- [knowledge-authoring.md](./knowledge-authoring.md) — preview-first
  authoring; the warnings doctor produces are the ones the authoring
  surface aims to retire.
- [pack-signatures.md](./pack-signatures.md) — the
  `pack-signature-invalid` blocker category and the dev-vs-release
  signing distinction R52 made explicit.
- [safety-model.md](./safety-model.md) — why doctor's `--blockers` is
  a *visibility* gate, not an authorisation one.
