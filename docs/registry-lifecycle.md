# Registry lifecycle symmetry rule (R28.9)

Scans the workspace for `register*` APIs without a matching `remove*` /
`unregister*` / `clear*`. Surfaces a common class of registry-lifecycle
issue: `registerUserPluginEntry` /
`registerAngularCdlPluginEntries` and related `register*ByScope`
patterns.

## Commands

```
shrk check registry-lifecycle
shrk check registry-lifecycle --changed-only    # scope to the working-tree diff (tracked + untracked)
shrk check registry-lifecycle --since <ref>     # scope to changes since <ref>
shrk registry lifecycle [--changed-only] [--since <ref>] [--json]
```

## Bounded, scoped scan

The scan can't hang. It's bounded by a hard **wall-clock budget** (default 15s)
that flushes partial results and exits **non-zero** with `timedOut: true` rather
than blocking a hook; oversized files are skipped and line offsets are
precomputed (the match locator was `O(n·m)`, now linear). `--changed-only`
(or `--since <ref>`) scopes the scan to the diff — tracked **and** untracked
files — so it runs inline in seconds. An empty changed scope is a **loud skip**
(`0 files in the changed scope — lifecycle NOT verified`), never a green pass.

The full-tree walk skips build artefacts + non-source trees (`node_modules`,
`dist`, `examples`, `e2e`, `scripts`, `tools`, …) by default. That default is
**configurable** — a repo that genuinely registers code under `tools/` or a
non-standard root sets its own set so a baked-in exclusion never silently blinds
the check:

```ts
// sharkcraft.config.ts — override the source-only default skip set.
export default {
  registryLifecycle: {
    skipDirs: ['node_modules', 'dist', '.git', 'coverage', 'build', 'out'],
  },
};
```

## Naming convention

| Register | Expected remover (any of) |
|---|---|
| `registerFoo` | `removeFoo`, `unregisterFoo`, `clearFoo` |
| `registerFooByScope` | `removeFooByScope`, `unregisterFooByScope`, `clearFooByScope` |

The scanner matches the stem after `register`, so scope-aware pairs
work out of the box.

## Annotations

When a register site genuinely has no remover by design:

```ts
// @shrkcrft lifecycle-ignore process-lifetime registry
export function registerFoo() { ... }
```

Or when cleanup is owned by a higher-level lifecycle:

```ts
// @shrkcrft lifecycle-managed-by di-scope-teardown
export function registerFoo() { ... }
```

Annotated sites appear under `ignored` in the report, not
`missingRemovers`.

## Output

```json
{
  "schema": "sharkcraft.registry-lifecycle/v1",
  "filesScanned": 2000,
  "registersFound": 49,
  "matchedPairs": [...],
  "missingRemovers": [
    {
      "registerName": "registerUserPluginEntry",
      "expectedRemoverNames": ["removeUserPluginEntry", "unregisterUserPluginEntry", "clearUserPluginEntry"],
      "file": "libs/.../register-foo.ts",
      "line": 12,
      "suggestion": "Add removeUserPluginEntry() / ... or annotate."
    }
  ],
  "ignored": [],
  "recommendations": [...]
}
```

## MCP

`get_registry_lifecycle_report({ limit? })` returns the same report
over the read-only MCP surface.
