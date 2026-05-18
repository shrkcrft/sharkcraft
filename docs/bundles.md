# Feature workflow bundles (R10)

A **feature workflow bundle** groups everything that goes into shipping one
feature: multiple generation plans, plan dependency ordering, validation runs,
and a final report. Bundles live under `.sharkcraft/bundles/<id>/` and are
managed by the `shrk bundle` command surface.

## Lifecycle

```bash
shrk bundle create "<task>"
shrk bundle plan <id> --all-suggested
shrk bundle graph <id> --format mermaid
shrk bundle next <id>                  # one-line: what's the next safe action
shrk bundle status <id>                # rich JSON / human snapshot
shrk bundle apply-assist <id> --write-script --validate-after-group --validate-final
shrk bundle validate <id> --all-verifications --report --html
shrk bundle review <id>                # pre-merge summary of all plans
shrk bundle report <id>                # final-report.md
shrk bundle record-apply <id> <plan>   # called automatically by apply-assist.sh
```

`bundle status` shows: id, task, status, plan groups, dependencies,
applied/unapplied plans, validation status, audit log entries, and next safe
action.

`bundle next` returns just the next command — useful for shell scripts.

`bundle review` summarizes plans, dependency order, introduced boundary risks,
missing validations, and human approval gates.

## Generated scripts

`bundle apply-assist --write-script` writes `.sharkcraft/bundles/<id>/reports/apply-assist.sh`
which:

- groups plans by `planGroups` and applies them in topological order
- prompts before each apply (`read -p "Continue? (yes/no)"`)
- runs `shrk apply ... --verify-signature` followed by `shrk bundle record-apply`
- with `--validate-after-group`, runs `shrk bundle validate --boundaries` between groups
- with `--validate-final`, runs `shrk bundle validate --all-verifications --report`
- logs every step to `reports/apply-assist.log`
- stops on the first failure (`set -euo pipefail`)

## Validation report v2

`shrk bundle validate <id> --all-verifications --report --html` emits:

- `reports/validate-<ts>.json` — raw validation result
- `reports/validate-<ts>.md` — gate matrix + plans + affected files
- `reports/validate-<ts>.html` — self-contained HTML version

`--all-verifications` enables `--boundaries --drift --coverage --agent-tests
--context-tests --test-impact` in one go. `--strict` upgrades warnings into
gate failures.

## Replay & resume (R11)

`shrk bundle replay <id> [--strict]` walks `apply-audit.log`, compares
recorded targets / hashes against the current plan files, and flags
tamper / missing-validation / out-of-order issues:

```bash
shrk bundle replay 2026-05-13T00-57-50-380Z-generate-a-user-profile-service
shrk bundle replay <id> --strict --json
```

Status values: `clean`, `warnings`, `tampered`, `missing`.

`shrk bundle apply-assist <id> --resume` skips plans already marked
`applied` and resumes from the next unapplied plan in topological
order. Add `--write-script` to materialize the resume script under
`reports/apply-assist.sh`.

## Cross-bundle replay (R12)

```bash
shrk bundle replay --all                          # human-readable summary
shrk bundle replay --all --json
shrk bundle replay --all --since "<id-substring>"  # filter bundles whose id matches
shrk bundle replay --all --report                  # write .sharkcraft/reports/bundle-replay-all.md
shrk bundle replay --all --html [--output /tmp/replay.html]
shrk bundle replay --all --strict                  # upgrade warnings to tampered
```

The batch report aggregates per-bundle status (`clean | warnings |
tampered | missing`), counts each, and lists the 10 most serious issues
across all bundles. Use it as a CI guardrail when many bundles
co-exist. `--since` matches case-insensitively against bundle ids (we
don't have a true cross-bundle timeline yet — see "Known limitations"
in R12's report).

The exit code is `0` only when no bundle is in `tampered` or `missing`
state.

## Cross-bundle replay CI scaffold (R13)

```bash
shrk bundle replay scaffold github-actions [--schedule weekly|daily|manual] [--with-report-site] [--output <path>] [--write] [--force]
```

Dry-run by default. The generated workflow runs `shrk bundle replay
--all --report --html` on the chosen schedule and uploads the artifacts.

`shrk ci scaffold github-actions --with-bundle-replay` adds the same
step to the main CI workflow.

## Bundle diff (R15)

```bash
shrk bundle diff <bundleA> <bundleB>
shrk bundle diff <bundleA> <bundleB> --format markdown
shrk bundle diff <bundleA> <bundleB> --format html --output /tmp/bundle-diff.html
shrk bundle diff <bundleA> <bundleB> --json
```

Compares two feature bundles and reports:

- metadata changes (`task`, `status`, `riskLevel`, `nextAction`)
- added / removed / changed plans (status, template, targets, variables, review)
- dependency add/remove
- plan-group add/remove/changed-membership
- validation add/remove
- affected-files add/remove

The HTML form is JS-free and dark-mode aware; the JSON form
(`sharkcraft.bundle-diff/v1`) is what `get_bundle_diff` (MCP) returns.

## MCP

- `list_feature_bundles` / `get_feature_bundle` — read-only access
- `replay_bundle_apply` — replay + tamper detection (read-only)
- `get_ci_scaffold_preview` — render the bundle-replay or main CI YAML (read-only)
- MCP never creates or modifies bundles.
