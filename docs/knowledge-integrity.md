# Knowledge integrity (R29)

R29 makes knowledge entries verifiable: each entry MAY declare
`references[]` and `anchors[]` that the engine checks against the
workspace. `shrk knowledge stale-check` is the standing verifier.

## Reference kinds

| kind | required fields | meaning |
|---|---|---|
| `file` | `path` | Project-relative file path. |
| `directory` | `path` | Project-relative directory. |
| `symbol` | `symbol`, optionally `path` | Exported function / class / type / enum. |
| `command` | `id` or `command` | A registered `shrk` command. |
| `template` | `id` | A registered template. |
| `playbook` | `id` | A pack-contributed playbook. |
| `construct` | `id` | A registered construct. |
| `helper` | `id` | A helper id from the R28 helper registry. |
| `policy` | `id` | A policy check id. |
| `boundary-rule` | `id` | A boundary rule id. |
| `path-convention` | `id` | A path-convention id. |
| `package` | `id` | A workspace package. |
| `url` | n/a | Not verified — no network. |

## Anchor kinds

Anchors are named points that rename tools can update:
`file | symbol | command | construct | template | helper | playbook | policy`.

## Commands

```
shrk knowledge stale-check [--changed-only|--since <ref>|--staged|--files] [--json]
shrk knowledge verify                                       # alias
shrk knowledge references <id> [--json]
shrk knowledge anchors [--json]

shrk knowledge rename-symbol <old> <new> [--write] [--json]
shrk knowledge rename-file <old-path> <new-path> [--write] [--json]
shrk knowledge update-anchor <anchorId> [--to-symbol|--to-path|--to-target-id <value>] [--write]
```

## Schema

Stale-check report: `sharkcraft.knowledge-stale/v1`. Includes
per-finding `outcome: ok|stale|missing|unknown` plus a
`symbolConfidence: exact|probable|missing|unknown` for symbol
references.

Rename plan: `sharkcraft.knowledge-rename/v1`. Lists every entry that
matches the rename plus the before/after value.

## Backwards compatibility

Pre-R29 entries omit `references` and `anchors` and still load. The
stale-check simply reports `0 references checked` for them.

## MCP

- `get_knowledge_stale_report({ changedFiles? })`
- `get_knowledge_references({ id })`
- `preview_knowledge_rename({ kind, from, to, anchorId?, toSymbol?, toPath?, toTargetId? })`

All read-only.

## Decision

`sharkcraft/decisions/knowledge-is-verifiable-not-tribal.md` documents
the policy intent.

## R30 — CI / preflight gate

Stale-check learns CI controls. Local mode stays non-blocking.

```
shrk knowledge stale-check --ci
shrk knowledge stale-check --strict
shrk knowledge stale-check --fail-on required,stale
shrk knowledge stale-check --baseline <prior.json>
shrk knowledge stale-check --report --format json --output .sharkcraft/reports/knowledge-stale.json
```

| Flag | Effect |
|---|---|
| `--ci` | exit non-zero if any reference with `required: true` is `stale` or `missing` |
| `--strict` | exit non-zero on any stale or missing required reference (alias of `--ci` today; reserved for stricter rules) |
| `--fail-on required` | exit non-zero only on `required: true` failures |
| `--fail-on stale` | exit non-zero on any stale outcome |
| `--fail-on missing` | exit non-zero on any missing outcome |
| `--fail-on all` | exit non-zero on any stale or missing reference |
| `--baseline <file>` | compare against a prior `--report` JSON; report `newStale` / `newMissing` / `resolved` |
| `--report` | write `.sharkcraft/reports/knowledge-stale-<timestamp>.json` |
| `--format text|markdown|html|json` | choose output format |
| `--output <path>` | explicit report path |

### Release readiness integration

```
shrk release readiness --strict --with-knowledge-check
```

Or set `knowledgeCheck.enabled: true` in `sharkcraft.config.ts`. The
readiness aggregator surfaces `knowledgeCheck: { ready, requiredFailing,
counts }` and forces `ready: false` when required references fail.

```ts
// sharkcraft.config.ts
const config = {
  // ...
  knowledgeCheck: {
    enabled: true,        // include in release readiness
    strict: false,        // promote any stale to a failure
    failOn: ['required'], // explicit list, otherwise CI default applies
  },
};
```

## R30 — AST-backed symbol verification

`packages/inspector/src/symbol-index.ts` parses single files via the
TypeScript compiler API (no whole-program type-checking, no extra
dependencies). Symbol references now report richer confidence:

- `exact-export` — declared with the `export` keyword.
- `exact-local` — declared in the file but not exported.
- `exact-reexport` — surfaced via `export { foo } from "..."`.
- `probable-text` — file could not be parsed; symbol appears as text.
- `missing` — symbol not declared or re-exported.
- `unknown` — file unreadable, etc.

The R29 text-scan path remains the fallback so a parse failure never
crashes the engine.
