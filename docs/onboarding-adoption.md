# Onboarding adoption

`shrk onboard adopt` is a safe workflow for taking the items inferred by
`shrk onboard --write-drafts` and turning them into a patch you can apply by
hand. It never modifies your live SharkCraft config files directly.

## Flow

```
shrk onboard --write-drafts          # produces drafts under sharkcraft/onboarding/
shrk onboard adopt                   # dry-run: classify items, no writes
shrk onboard adopt --write-patch     # writes sharkcraft/onboarding/adoption/
shrk onboard adopt review            # human-readable categorised review
shrk onboard adopt diff              # line-level diff vs live config (R14)
shrk onboard adopt diff --format html    # JS-free dark-mode aware
shrk onboard adopt diff --format json    # for CI gates
git apply sharkcraft/onboarding/adoption/adopt.patch
```

## Live diff (R14)

`shrk onboard adopt diff` answers "if I applied the adoption patch, what
would change in my live `sharkcraft/*.ts` files?" — block by block:

- **new-block** — append a marked block to `rules.ts` / `paths.ts` / etc.
- **already-exists** — id is already in the live config (informational).
- **conflict** — id collision with a different shape.
- **manual-review** — generated drafts that need a human read first.

The diff respects the same path-safety rules as `--write-patch`: it only
ever proposes changes under your `sharkcraft/` config files; it never
proposes writes outside `sharkcraft/onboarding/adoption/`. The HTML format
is JS-free; the JSON form is consumed by the MCP tool
`get_onboard_adoption_diff` (read-only).

## Categories

Every inferred item is classified into exactly one of:

| Category          | Meaning                                                              |
|-------------------|----------------------------------------------------------------------|
| safe-to-adopt     | High-confidence, no conflict with existing config                    |
| manual-review     | Needs a human to review (templates, imported agent rules, …)         |
| low-confidence    | Below the confidence threshold — left out unless `--confidence low`  |
| conflict          | Conflicts with an item already in the live config                    |
| already-covered   | Live config already covers this id                                   |
| skipped           | Excluded via `--exclude` (or the kind is not in `--include`)         |

Confidence threshold is `high` by default. Pass `--confidence medium` or
`--confidence low` to widen the funnel.

## Selecting kinds

```
shrk onboard adopt --include rules,paths,verifications,pipelines
shrk onboard adopt --exclude templates,boundaries
shrk onboard adopt --confidence medium --include rules
```

Templates and boundaries are excluded by default and must be explicitly
included.

## Output

When you pass `--write-patch`, SharkCraft writes three files under
`sharkcraft/onboarding/adoption/`:

```
adoption-plan.md        # human-readable plan
adopt.patch             # patch file (pseudo or unified format)
adopt-summary.json      # structured summary with target hashes
```

The patch only **appends** marked blocks to the target files (`rules.ts`,
`paths.ts`, `pipelines.ts`, `sharkcraft.config.ts`). It never overwrites
existing entries.

## Patch formats

```bash
shrk onboard adopt --write-patch                          # pseudo (default)
shrk onboard adopt --write-patch --diff-format unified    # git-apply-compatible
```

- **pseudo** (default): sentinel-marked `@@ append @@` blocks. Human-readable;
  copy the additions into the target file by hand. Safe — `git apply` will
  reject it because it isn't a real hunk, so you can't apply it by accident.
- **unified**: real `git apply`-compatible unified diff. For missing target
  files the patch emits a full-file create. For existing target files the
  patch appends at EOF with a 3-line context window so git can find the
  insertion point.

In unified mode SharkCraft records a SHA-256 hash of each existing target
file in `adopt-summary.json`. `shrk onboard adopt review` re-hashes the
targets and warns when they have changed since the patch was written — so
you can regenerate before applying an out-of-date diff.

```bash
git apply sharkcraft/onboarding/adoption/adopt.patch
```

## Adoption state

Every `shrk onboard adopt --write-patch` also writes
`sharkcraft/onboarding/adoption/adoption-state.json` (schema
`sharkcraft.adoption-state/v1`). It records:

- `sourceDraftFiles[]` + hashes (every file under `sharkcraft/onboarding/`)
- `targetFiles[]` + hashes (every file the patch references)
- `generatedFiles[]`, `patchPath`, `summaryPath`
- `diffFormat`, `confidenceThreshold`, `includedKinds`, `excludedKinds`
- `categories` (ids grouped by safe-to-adopt / manual-review / …)
- `freshness` ({status, staleReasons})
- `warnings[]`, `nextCommands[]`

The state file is the single source of truth for "is the patch still
valid against the current target files?".

## Subcommands

```bash
shrk onboard adopt status                            # patch + freshness summary
shrk onboard adopt regenerate                        # archive + rebuild
shrk onboard adopt regenerate --force                # overwrite current outputs
shrk onboard adopt merge-preview                     # 3-way verdict per target
shrk onboard adopt merge-preview --format markdown
shrk onboard adopt merge-preview --format html
shrk onboard adopt report                            # full report
shrk onboard adopt report --format html --output /tmp/adoption.html
shrk onboard adopt check                             # git apply --check or internal
shrk onboard adopt --write-patch --no-auto-regenerate # opt out of auto-rewrite
```

`status` reports patch/summary/state existence, freshness, target/draft
diffs, category counts, and the next safe command.

`regenerate` archives the previous adoption-state.json + adopt.patch (and
the plan/summary) under `sharkcraft/onboarding/adoption/history/` —
timestamped so previous runs are never overwritten — then rebuilds.

`merge-preview` runs a non-writing **three-way classifier** over every
target the patch touches:

| Verdict             | Meaning                                                        |
|---------------------|----------------------------------------------------------------|
| `safe`              | Target hash unchanged since the patch was generated            |
| `probably-safe`     | Target changed but the append context is recognizable          |
| `create-file-safe`  | Patch creates a new file; the target still doesn't exist       |
| `stale-target`      | Target disappeared / was created after the patch was generated |
| `stale-draft`       | Draft files changed since the patch was generated              |
| `manual-review`     | Patch appears already applied, or target is unrecognisable     |
| `conflict`          | Reserved for future hash-based 3-way merging                   |

`check` validates patch applicability without applying it. For unified
diffs it runs `git apply --check`; for pseudo diffs it re-hashes targets.

## Auto-regeneration

When you run `shrk onboard adopt --write-patch --diff-format unified` and
the previously-recorded target hashes have changed, SharkCraft auto-archives
the prior patch + state under `history/` and writes new ones. Pass
`--no-auto-regenerate` to preserve the old behavior.

## MCP

Read-only MCP tools mirror the CLI:

- `create_onboarding_adoption_plan`
- `get_onboarding_adoption_review`
- `get_adoption_report` (text / markdown / html / json)

None write the patch. They return the structured plan + a `nextCommand`
pointing to the CLI write step.
