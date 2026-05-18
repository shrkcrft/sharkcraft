# CI scaffold

`shrk ci scaffold github-actions` writes a starter GitHub Actions workflow
that wires up the SharkCraft checks you want. Dry-run by default.

```bash
shrk ci scaffold github-actions --with-quality --with-review --with-boundaries
shrk ci scaffold github-actions --with-coverage --with-agent-tests --write
```

## Flags

| Flag                  | Adds the step                                     | Artifact                       |
|-----------------------|---------------------------------------------------|--------------------------------|
| `--with-quality`      | `shrk quality --ci > quality.json`                | `sharkcraft-quality`           |
| `--with-review`       | `shrk review --since origin/main --json`          | `sharkcraft-review-packet`     |
| `--with-boundaries`   | `shrk check boundaries --json`                    | `sharkcraft-boundaries`        |
| `--with-coverage`     | `shrk coverage --json`                            | `sharkcraft-coverage`          |
| `--with-agent-tests`  | `shrk test agent --json`                          | `sharkcraft-agent-tests`       |
| `--with-drift-gate`   | chains `--require-drift-clean` onto the `--with-quality` step | (folded into `sharkcraft-quality`) |
| `--with-node-compat`  | `bun run compat:node > node-compat.json`          | `sharkcraft-node-compat`       |
| `--with-safety-audit` | `shrk safety audit --json`                        | `sharkcraft-safety-audit`      |
| `--with-command-doctor` | `shrk commands doctor --json`                   | `sharkcraft-commands-doctor`   |
| `--with-pack-tests --pack-paths a,b` | one `shrk packs test <p> --load --json` per comma-separated path | `sharkcraft-pack-<basename>` (one per path) |
| `--with-impact` (R13)            | `shrk impact --since origin/main --format json` | `.sharkcraft/reports/impact.json` |
| `--with-policy-snapshot-gate` (R13) | `shrk policy snapshot --all --gate --json`  | `policy-snapshots.json`         |
| `--with-bundle-replay` (R13)     | `shrk bundle replay --all --report --html`     | `.sharkcraft/reports/bundle-replay-all.md` |
| `--with-report-site` (R13)       | `shrk report site --output .sharkcraft/reports/site` | `.sharkcraft/reports/site/index.html` |
| `--with-knowledge-check` (R30)   | `shrk knowledge stale-check --ci --format json` | `.sharkcraft/reports/knowledge-stale.json` |
| `--with-template-drift` (R30)    | `shrk templates drift --ci --format json`     | `.sharkcraft/reports/template-drift.json` |
| `--with-integrity` (R30)         | shortcut: enables both `--with-knowledge-check` and `--with-template-drift` | both artifacts |

The scaffold uploads each artifact via `actions/upload-artifact@v4` with
`if: always()` so failed runs still surface their data.

`--with-drift-gate` requires `--with-quality` (it modifies that step's
arguments). The other flags can be combined freely.

```bash
shrk ci scaffold github-actions \
  --with-quality --with-drift-gate \
  --with-node-compat \
  --with-safety-audit \
  --with-command-doctor \
  --with-pack-tests --pack-paths ./packs/my-pack \
  --write
```

## Output

```bash
shrk ci scaffold github-actions --with-quality              # prints YAML to stdout
shrk ci scaffold github-actions --with-quality --write      # writes .github/workflows/sharkcraft.yml
shrk ci scaffold github-actions --output ops/sharkcraft.yml --write
```

Refuses to overwrite an existing file unless you pass `--force`.

## Jenkins / Azure DevOps / CircleCI

R48 removed the CLI surface for these providers (`shrk ci scaffold
circleci|azure|azure-pipelines|jenkins`). The underlying generators
(`circleciYaml`, `azureYaml`, `azureFromInputs`, `jenkinsFile`) still
live in `packages/cli/src/commands/ci.command.ts` and can be imported
by pack authors who need them. See
[`docs/ci-providers.md`](ci-providers.md).

## CI permissions audit (R15)

```bash
shrk ci permissions <workflow-file> [--provider github-actions|gitlab|bitbucket|azure|jenkins] [--json]
```

Audits the generated (or hand-written) workflow file for write scopes,
PR-comment posting, token usage, external actions/images, and artifact
uploads. Returns a least-privilege recommendation. See
[ci-permissions.md](ci-permissions.md) for the full audit reference.

## GitLab and Bitbucket (R14)

```bash
shrk ci scaffold gitlab    --with-quality --with-policy --with-impact --with-report-site
shrk ci scaffold bitbucket --with-quality --with-policy --with-impact --with-report-site
```

`gitlab` emits a `.gitlab-ci.yml`-style file with three explicit stages:
`sharkcraft_quality`, `sharkcraft_review`, `sharkcraft_reports`. Each
gate flag adds the matching job — `sharkcraft:quality`,
`sharkcraft:policy`, `sharkcraft:impact`, `sharkcraft:review`,
`sharkcraft:report-site`, `sharkcraft:bundle-replay`,
`sharkcraft:compat-node`. Artifacts are scoped per job and only kept on
the runs that produced them.

`bitbucket` emits a `bitbucket-pipelines.yml` with two pipelines:

- `pipelines.pull-requests` — runs the selected steps on every PR.
- `pipelines.custom.sharkcraft-governance` — manually triggered
  governance run (doctor + quality + policy + bundle-replay + report site).

Both scaffolds support the same flag matrix as `github-actions` (quality,
policy, policy-snapshot-gate, impact, review, report-site,
bundle-replay, node-compat). Dry-run by default; refuses to overwrite
without `--force`.

MCP: `get_ci_scaffold_preview` now accepts `provider`
(`github-actions | gitlab | bitbucket`) and returns the rendered YAML +
the canonical output path. No writes.

## Bundle-replay schedule (R13)

```bash
shrk bundle replay scaffold github-actions --schedule weekly|daily|manual [--with-report-site]
```

Generates a separate `.github/workflows/sharkcraft-bundle-replay.yml`
that runs `shrk bundle replay --all --report --html` on the chosen
schedule (defaults to weekly cron `17 6 * * 1`).

## What it intentionally does NOT do

- Does not call the GitHub API
- Does not post PR comments (use `shrk review render-comment` + `gh pr comment`)
- Does not pin actions to commit SHAs (review the workflow before adopting)
- Does not enable branch protection rules
