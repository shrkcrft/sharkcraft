# Import hygiene (R36 + R37 + R38 allowlist tooling)

R36 introduced a deterministic import-hygiene checker that flags bad
patterns that hide module dependencies or invent cycles where none exist.
**R37** tightens the policy: lazy `require('node:*')` is now an **error**
(was a warning in R36), because Node built-ins gain nothing from lazy
loading — they are already in memory before any user code runs, and the
`as typeof import('node:*')` cast is a hack to satisfy strict TS where a
top-level `import` would have typed the call for free.

## What gets flagged

| Kind | Default severity | Example |
|---|---|---|
| `inline-type-import` | `error` | `field?: import('./x').Type;` |
| `runtime-require` (any spec — `node:*` or relative) | `error` (R37) | `const mod = require('./x.ts');` / `const fs = require('node:fs');` |
| `dynamic-import` | `warning` (or `info` when allowlisted) | `const m = await import('./x.ts');` |

`typeof import('./x')` is a TS type expression and is NOT flagged.
Comments are excluded from scanning (string literals are scanned —
the regex is intentionally simple; legitimate fixtures live in tests
and rarely need a `require('node:*')` substring).

## R38 — allowlist tooling

R38 adds flags that make bulk allowlisting safe:

```bash
shrk check imports --emit-allowlist <file>
shrk check imports --emit-allowlist-kind dynamic-import|runtime-require|inline-type-import|all
shrk check imports --only-allowlist-candidates
shrk check imports --fail-on-unexplained-allowlist
```

- `--emit-allowlist <file>` writes a draft JSON allowlist of the
  current findings. Each entry's `reason` is the sentinel
  `"TODO: explain why this <kind> is intentional ..."` — a human must
  replace it with a real justification before the entry is accepted
  in strict mode.
- `--emit-allowlist-kind` restricts the draft to one kind. Default is
  `dynamic-import` — `runtime-require` and `inline-type-import` are
  never batched and must be opted in.
- `--only-allowlist-candidates` prints just the draft JSON (no full
  report).
- `--fail-on-unexplained-allowlist` activates strict mode: allowlist
  entries with empty / TODO reasons do NOT suppress findings, and the
  CLI exits non-zero with a list of unexplained entries.

## Commands

```bash
shrk check imports
shrk check imports --changed-only
shrk check imports --since main
shrk check imports --json
```

Exits non-zero only when `error`-severity findings are present.

## Allowlist

`sharkcraft/import-hygiene.allowlist.json`:

```json
{
  "$schema": "sharkcraft.import-hygiene-allowlist/v1",
  "allow": [
    {
      "path": "packages/cli/src/commands/context.command.ts",
      "kind": "dynamic-import",
      "reason": "CLI subcommand lazy-load — only used when the subcommand fires."
    }
  ]
}
```

Each entry **must** carry a `reason`. The checker downgrades matching
findings from `warning` to `info` (or from `error` to `info` for explicit
overrides). Do not add allowlist entries without justification.

## Schemas

- Report: `sharkcraft.import-hygiene/v1`
- Allowlist: `sharkcraft.import-hygiene-allowlist/v1`

## Rationale

Inline `import('./x').Type` and runtime `require('./x')` are escape
hatches that:

1. Hide cross-module dependencies from the static-analysis surface.
2. Invent fake circular-dependency cures (sometimes there is no cycle).
3. Resist refactors — renaming a module silently breaks one of these
   sites only at runtime, in the cold path that nobody tests.

### Why `require('node:*')` is also forbidden (R37)

Node built-ins like `node:fs`, `node:path`, `node:os`, `node:crypto`,
`node:child_process`, `node:url` are resolved by Node itself before any
user code runs. There is no startup cost to amortize by lazy-loading
them. The pattern

```ts
const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs');
```

inside a function body is:

1. **Pointless** — the module is already in memory.
2. **A type smell** — `require()` returns `any`; the cast retypes it.
   A normal `import` types the call for free.
3. **Dependency-hiding** — every dependency-graph tool treats it as
   "no fs dependency at all," which misleads boundary checks.

The R36 spec calls out one concrete case in `agent-handoff.ts`:

```ts
// R35-era pattern — broken
uncertainty?: import('./uncertainty-report.ts').IUncertaintyReport;

// inside buildHandoffUncertainty:
const { buildUncertaintyReport } = require('./uncertainty-report.ts') as ...
```

Fixed to:

```ts
import { buildUncertaintyReport, type IUncertaintyReport } from './uncertainty-report.ts';
// ...
uncertainty?: IUncertaintyReport;
```

No cycle exists between these modules; the hack was unnecessary.

## Tests

`r36-reliability-hardening.test.ts > R36 — Import hygiene checker` covers
all three finding kinds plus the comment-stripping false-positive guard,
the `typeof import(...)` exclusion, the allowlist roundtrip, and the
`agent-handoff` regression guard.

`r37-no-lazy-node-builtin.test.ts > R37 — require(node:*) is
error-severity` covers the R37 promotion, the allowlist-still-downgrades
case, the **engine-wide regression guard** (the entire codebase has zero
lazy `require('node:*')` findings), and verifies the
`repo.imports.no-lazy-node-builtin-require` SharkCraft rule is registered
with the correct `verificationCommands` and `forbiddenActions`.

## Related rule

The SharkCraft rule `repo.imports.no-lazy-node-builtin-require` is the
human-facing form of this checker. It is loaded from
`sharkcraft/rules.ts` and surfaces in `shrk context`, `shrk task`, and
`shrk recommend` so agents and humans see the policy where they work.
