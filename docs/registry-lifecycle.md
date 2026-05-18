# Registry lifecycle symmetry rule (R28.9)

Scans the workspace for `register*` APIs without a matching `remove*` /
`unregister*` / `clear*`. Surfaces a common class of registry-lifecycle
issue: `registerUserPluginEntry` /
`registerAngularCdlPluginEntries` and related `register*ByScope`
patterns.

## Commands

```
shrk check registry-lifecycle
shrk registry lifecycle [--json]
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
