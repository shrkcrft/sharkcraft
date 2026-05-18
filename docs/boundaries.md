# Boundary rules

A boundary rule declares which imports are forbidden — or, with an
`allowedImports` whitelist, which imports are permitted — for a set of
files. SharkCraft scans your project, evaluates every rule, and reports
violations.

## Minimum example

```ts
import { defineBoundaryRule } from '@shrkcrft/boundaries';

export default [
  defineBoundaryRule({
    id: 'core.no-ui-imports',
    title: 'core must not import UI',
    severity: 'error',
    from: ['src/core/**'],
    forbiddenImports: ['@scope/ui-*'],
    message: 'Core libraries must stay UI-free.',
    suggestedFix: 'Move shared contracts into core or invert the dependency.',
  }),
];
```

Ship it as `sharkcraft/boundaries.ts` (local) or contribute it from a pack
via `boundaryFiles: ['./src/assets/boundaries.ts']`.

## Glob semantics

The matcher recognizes:

- `**` — zero or more path segments.
- `*` — any chars except `/`.
- `?` — single char except `/`.

It's intentionally small — no extglob, no negation. If you need richer
patterns, file an issue.

## Commands

```bash
shrk check boundaries
shrk check boundaries --json
shrk check boundaries --strict          # warnings fail too
shrk check boundaries --rule <id>       # evaluate one rule
```

Exit code is non-zero when there are `error` violations (or any
violations when `--strict`).

## MCP

```
check_boundaries           # full evaluation
list_boundary_rules        # all registered rules + source
get_boundary_rule          # one rule with details
get_import_graph_summary   # files scanned, internal/external counts
```

All read-only. The MCP server never writes.

## tsconfig path aliases

The checker reads `tsconfig.base.json` / `tsconfig.json` from the project
root. `compilerOptions.paths` are resolved against every import specifier:

- Exact aliases (`"@app/adapter-core": ["packages/app/adapter/adapter-core/src/index.ts"]`)
- Wildcard aliases (`"@app/*": ["packages/app/*/src/index.ts"]`)

A rule's `forbiddenImports` / `allowedImports` patterns are matched
against the **literal** specifier *and* the **resolved** path. Write your
rule against project paths and it will catch alias-prefixed imports too:

```ts
{ from: ['packages/app/core/**'], forbiddenImports: ['packages/app/ui/**'] }
```

Violations include `resolvedVia` when the match came via the alias map.

## v1 limitations

- Regex-based scanner. Comments and string escapes can fool it; if a file
  looks broken in the report, file an issue with the import that confused
  it.
- Built-in glob is small (`**` / `*` / `?` only).
- Module resolution does NOT chase `index.ts` / `.d.ts` /
  `node_modules` — only the path alias map is honored.
