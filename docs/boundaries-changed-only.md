# Boundary changed-only mode (R28.1)

The single most painful thing about `shrk check boundaries` is a
recurring real-world motivation: filtering pre-existing violations so PRs
surface only the new ones. R28 adds a changed-scope filter to every
boundary view.

## Commands

```
shrk check boundaries --changed-only
shrk check boundaries --since main
shrk check boundaries --since HEAD~5
shrk check boundaries --staged
shrk check boundaries --files src/a.ts,src/b.ts
shrk check boundaries --polyglot --changed-only

shrk boundaries enforce --changed-only
shrk architecture violations --changed-only
```

## JSON shape

```json
{
  "passed": true,
  "counts": { "error": 0, "warning": 0, "info": 0 },
  "changedScope": {
    "mode": "changed-only",
    "changedFiles": ["libs/a.ts", "libs/b.ts"],
    "includedViolations": [],
    "ignoredLegacyCount": 25,
    "ignoredLegacyByRule": {
      "no-circular-imports": 14,
      "no-internal-imports": 11
    }
  }
}
```

## Scope resolution

| Flag | Source | Notes |
|---|---|---|
| `--changed-only` | working tree (untracked + modified) | default scope when no other flag set |
| `--since <ref>` | `git diff --name-only <ref>` | use a branch or SHA |
| `--staged` | `git diff --cached --name-only` | pre-commit usage |
| `--files a,b,c` | explicit list | bypasses git entirely |

## "No new violations" message

When changed-scope filtering is active and the included list is empty:

```
No boundary violations introduced by changed files.
```

The exit code is 0 only if there are 0 errors **in the included
violations** — legacy violations don't fail the check.

## MCP

`get_changed_boundary_report({ since?, staged?, files?, polyglot? })`
returns the same shape over the read-only MCP surface.

## Backward compatibility

The default behaviour of `shrk check boundaries` (no scope flags) is
identical to R27. Existing callers see no change.

## R29: shared changed-scope quality model

R29 generalises the changed-only filter into a shared
`IChangedScopeClassification` (schema `sharkcraft.changed-scope/v1`).
Buckets: `new-in-changed-file | existing-touched |
existing-untouched-hidden | resolved | unknown | unchanged |
out-of-scope`. The same scope flags now work on:

```
shrk policy run --changed-only|--since|--staged|--files
shrk drift --changed-only|--since|--staged|--files
```

Boundary checking continues to use its dedicated filter as a fast path;
the shared classifier is the consistent model the other engines build
on.

See `docs/knowledge-integrity.md` for the related stale-check and
`docs/template-drift.md` for template verification.
