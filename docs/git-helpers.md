# Git helpers

Read-only wrappers around `git` for use by impact / review / test-impact.
Never run write-side git operations (no commit/push/apply).

```bash
shrk git changed [--since <ref>] [--staged] [--include-worktree] [--json]
shrk git root
shrk git branch
shrk git status-summary [--json]
```

When the working tree is not a git repo, helpers return safe empty values
rather than throwing.
