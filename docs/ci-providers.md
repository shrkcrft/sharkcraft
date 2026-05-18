# CI scaffold providers

`shrk ci scaffold <provider> [...flags]` generates a starter CI config.

**R48 change:** GHA is first-class. GitLab and Bitbucket are supported.
CircleCI, Azure DevOps / Azure Pipelines, and Jenkins providers were
removed from the CLI in R48 because they were untested in dogfood and
nobody used them. Their generators still exist in the codebase
(`circleciYaml`, `azureYaml`, `azureFromInputs`, `jenkinsFile`) — pack
authors who need them can import directly or run their own scaffold.

Providers exposed by `shrk ci scaffold <provider>`:

| Provider           | Default output                      |
|--------------------|-------------------------------------|
| `github-actions`   | `.github/workflows/sharkcraft.yml`  |
| `gitlab`           | `.gitlab-ci.yml`                    |
| `bitbucket`        | `bitbucket-pipelines.yml`           |

Other providers (advisory; not wired into the CLI):

- **CircleCI** — see the `circleciYaml` builder in
  `packages/cli/src/commands/ci.command.ts`.
- **Azure DevOps / Azure Pipelines** — see `azureYaml` /
  `azureFromInputs`.
- **Jenkins** — see `jenkinsFile`.

Flags (apply to every wired provider):

- `--with-quality`
- `--with-review`
- `--with-boundaries`
- `--with-coverage`
- `--with-drift`
- `--with-drift-gate`
- `--with-baseline`
- `--with-policy`
- `--with-owners`
- `--with-test-impact`
- `--with-dashboard-e2e`
- `--with-node-compat`
- `--with-safety-audit`
- `--with-command-doctor`
- `--with-pack-tests --pack-paths <a,b>`

`--write` materializes the file; default is dry-run. No API calls; no
PR-comment posting by default — that's left to the human.
