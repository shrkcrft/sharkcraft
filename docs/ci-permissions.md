# CI permissions audit

`shrk ci permissions <workflow-file>` reads a CI workflow file and
reports what scopes / tokens / external dependencies it implies — and
recommends a least-privilege block to copy in. Read-only.

```bash
shrk ci permissions .github/workflows/sharkcraft-pr-review.yml
shrk ci permissions .gitlab-ci.yml --provider gitlab
shrk ci permissions bitbucket-pipelines.yml --provider bitbucket
shrk ci permissions azure-pipelines.yml --provider azure
shrk ci permissions Jenkinsfile --provider jenkins
shrk ci permissions .github/workflows/x.yml --json
```

The audit is regex-based — no YAML parser, no network resolution. It
catches the dominant safety questions:

- Does the workflow request **write** scopes?
- Does it post comments to a PR / MR?
- Does it use tokens?
- Does it pull in external actions or container images?
- Does it upload artifacts?

Every finding has a stable `code`, a `severity` (`info | warning | error`),
the lines where the trigger fired, and an optional remediation hint.

## Provider notes

- **GitHub Actions** — detects `permissions:` blocks, `*-pr-comment`
  actions, `gh pr comment`, `actions/github-script`, GITHUB_TOKEN /
  GH_TOKEN usage, and `actions/upload-artifact@`.
- **GitLab** — detects `merge_requests/.../notes` API calls and
  `PRIVATE-TOKEN` / `$CI_JOB_TOKEN` / `$REVIEW_TOKEN`.
- **Bitbucket** — detects `pullrequests/.../comments` API calls and
  `$BITBUCKET_TOKEN`.
- **Azure** — detects `$(System.AccessToken)` and `PublishPipelineArtifact`.
- **Jenkins** — detects `credentials(...)` / `withCredentials` and
  `archiveArtifacts`.

## Least-privilege recommendation

For a workflow that does **not** post comments:

```yaml
permissions:
  contents: read   # least-privilege default for the SharkCraft review surface
```

For a workflow that **does** post comments:

```yaml
permissions:
  contents: read
  pull-requests: write   # required by the comment-posting step
```

The audit will warn if `pull-requests: write` is requested but no
comment-posting step is detected (you can usually drop it).

## MCP

`get_ci_permissions_audit` returns the same payload. Read-only; never
fetches anything from the network.
