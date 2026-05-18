# PR review GitHub Action

`shrk review scaffold github-action` prints a workflow YAML that runs
SharkCraft checks on every pull request and uploads each result as a build
artifact.

## Generate the workflow

```bash
# Baseline: review packet only
shrk review scaffold github-action > .github/workflows/sharkcraft-review.yml

# Full bot: review packet + boundaries + coverage + drift + comment placeholder
shrk review scaffold github-action \
  --with-boundaries \
  --with-coverage \
  --with-drift \
  --comment-placeholder \
  > .github/workflows/sharkcraft-review.yml
```

## Flags

| Flag | What it adds |
|---|---|
| `--with-boundaries` | `shrk check boundaries --json` → `boundaries.json` artifact |
| `--with-coverage` | `shrk coverage --json` → `coverage.json` artifact |
| `--with-drift` | `shrk drift --json` → `drift.json` artifact |
| `--artifact-only` | Skip the comment placeholder even if requested |
| `--comment-placeholder` | Append a step that runs `shrk review render-comment` and prints how to post it via `gh pr comment` |

The baseline workflow:

1. Checks the PR out with `fetch-depth: 0` so the diff base is available.
2. Installs Bun via `oven-sh/setup-bun`.
3. Runs `bun install` to wire workspace deps.
4. Runs the selected SharkCraft checks.
5. Uploads each as a separate `sharkcraft-*` artifact.

## Posting as a PR comment

Two pieces:

1. **Render the comment.** `shrk review render-comment review-packet.json`
   reads the review packet JSON (the same one the workflow produces) and
   emits a Markdown PR comment. Pass `--output comment.md` to write to a
   file, or `--title "<title>"` to customise the header. Sections:
   - Summary
   - Changed files
   - Risks
   - Boundary issues
   - Suggested checks
   - Relevant rules (when present)
   - AI reviewer instructions (collapsed `<details>`)
   - Artifacts note
2. **Post it.** Wire `gh pr comment $PR --body-file comment.md` or use
   `actions/github-script` — the `--comment-placeholder` scaffold step shows
   you exactly the invocation. SharkCraft never calls the GitHub API on your
   behalf; the post-step is yours to configure.

```bash
# Local preview from a saved packet.
shrk review --since origin/main --json > review-packet.json
shrk review render-comment review-packet.json --output review-comment.md
```
