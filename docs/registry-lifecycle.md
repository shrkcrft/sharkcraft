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
shrk check registry-lifecycle --limit 500       # file cap (default 2000; --limit 0 = uncapped)
shrk check registry-lifecycle --offset 2000     # continue a capped / timed-out / interrupted run
shrk check registry-lifecycle --budget-ms 60000 # wall-clock budget (default 15000)
shrk registry lifecycle [same flags] [--json]
```

`check registry-lifecycle` and `registry lifecycle` are one body
(`registry-lifecycle-run.ts`) and settle through the shared gate envelope
(`gate.verb`, rule type `lifecycle`) — see [gate-json.md](gate-json.md).

## Verdicts and exit codes

| Outcome | Exit |
|---|---|
| a missing remover in the examined files | `1` — a violation is real however much of the tree was read |
| every candidate judged, every register paired / one-shot / annotated | `0` |
| a **capped** scan (`--limit` reached), an **expired budget**, an **interrupted** run (SIGTERM / SIGINT) | `2`, with the `--offset` that continues it |
| a file over its per-file budget, or unreadable | `2`, the file named |
| nothing in scope (an empty changeset, no candidates) or no `register*` declaration in the examined files | `2` — `--allow-empty` accepts it explicitly (`0`, printed as `accepted by --allow-empty`) |
| a malformed flag (`--limit abc`, `--offset -1`) or an unknown one | `3` |

`--allow-empty` only ever accepts an EMPTY scope; it never accepts a capped or
over-budget one.

## Bounded, and honest about the bound

Candidates are **sorted by project-relative path**, so a page is deterministic:
`--offset <n>` starts at the n-th candidate and `--limit <k>` takes k of them.
Whenever candidates remain — the cap was reached, the budget expired, or a
signal stopped the run — the report carries `nextOffset`, and the NOT VERIFIED
line names it:

```
  ! capped — scanned 2000 of 2103 candidate files (cap --limit 2000); 103 unexamined. Continue: shrk check registry-lifecycle --offset 2000   (or --limit 0 for an uncapped run)

NOT VERIFIED: capped at 2000 of 2103 files under /repo — --limit 2000 reached; continue with --offset 2000 (or --limit 0 for an uncapped run) (this is not a pass)
```

Pages compose: the union of `--offset 0 --limit k`, `--offset k --limit k`, …
is exactly the `--limit 0` run.

The **wall-clock budget** (`--budget-ms`, default 15 s) is checked between files
AND inside each file — after the comment/string strip, after the declaration
scan, and before every register's remover lookup. A file that runs past its own
sub-budget (`max(1 s, budget / 4)`) is abandoned whole — none of its partial
findings are kept — and listed under `overBudgetFiles` with the phase it ran out
in; the scan continues with the next file. When the run's own deadline expires
inside a file, the scan stops there and `nextOffset` points AT that file, so the
continuation re-scans it. Every per-file step is linear (no two
newline-spanning quantifiers touch in any pattern run on the blanked buffer; the
remover lookup is one pass per file), so the checks are close together.

**SIGTERM / SIGINT** stop the scan between files and print the partial report —
`! INTERRUPTED — partial results (scanned N/M); continue with … --offset K` — and
exit `2`. A killed run is no longer zero bytes.

`--changed-only` (or `--since <ref>`) scopes the scan to the diff — tracked
**and** untracked files — so it runs inline in seconds. A deleted file in the
diff is narrowing (not in scope), never a shortfall.

Generated files (`.d.ts`, `.generated.ts`, `// @generated`) are **excluded
and named** (`excludedFiles.generated`) — a deliberate narrowing. A file over
the 256 KB lifecycle read cap is different: it stays in the files coverage's
`expected` scope and is named **unexamined** (`! over read cap` in text,
`excludedFiles.oversized` plus the coverage's `unexamined` in JSON), so a run
with one settles NOT VERIFIED (2) — a missing remover inside it can never read
as a clean ✓. A cap is never a narrowing.

## Skipped directories

The full-tree walk skips build artefacts + non-source trees (`node_modules`,
`dist`, `build`, `out`, `coverage`, `examples`, `e2e`, `fixtures`, `scripts`,
`tools`, …) by default. To skip one more directory, EXTEND the defaults:

```ts
// sharkcraft.config.ts
export default {
  registryLifecycle: {
    skipDirsAdd: ['generated-fixtures'],
  },
};
```

`skipDirs` is the advanced form: it REPLACES the default set — for a repo that
genuinely registers code under `tools/` or a non-standard root. A replacing list
that drops a dependency / build default (`node_modules`, `dist`, `build`, `out`,
`coverage`, `.sharkcraft`) makes the scan read vendored and generated code, so
it is reported — in the scan (`droppedDefaultSkipDirs`, a `warnings[]` line) and
by `shrk doctor` (`registry-lifecycle-skip-dirs`):

```
! registryLifecycle.skipDirs replaces the defaults and drops: node_modules, dist — use skipDirsAdd to extend the default skip set instead
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
  "totalFiles": 2103,
  "truncated": true,
  "timedOut": false,
  "interrupted": false,
  "offset": 0,
  "limit": 2000,
  "candidatesExamined": 2000,
  "nextOffset": 2000,
  "excludedFiles": { "generated": 3, "missing": 0, "oversized": [] },
  "overBudgetFiles": [],
  "skipDirs": ["..."],
  "droppedDefaultSkipDirs": [],
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
  "coverage": { "unit": "files", "expected": 2100, "examined": 2000, "capped": true, "reason": "--limit 2000 reached; continue with --offset 2000 (or --limit 0 for an uncapped run)" },
  "registrationCoverage": { "unit": "registrations", "expected": 49, "examined": 49 },
  "verdict": "not-verified",
  "exitCode": 2,
  "gate": { "schema": "sharkcraft.gate/v1", "verb": "check registry-lifecycle", "exit": 2, "...": "..." }
}
```

The CLI's `--json` top-level `verdict` / `exitCode` are the SETTLED ones (the
same number the process exits with); `gate` is the shared envelope.

## MCP

`get_registry_lifecycle_report({ limit?, offset? })` returns the same report
over the read-only MCP surface, including `verdict` / `verdictReason` and
`nextOffset` — pass it back as `offset` to continue a capped scan.

### Verdict vocabulary: CLI `--json` vs MCP

Two vocabularies name the same settled answer. Both read the same coverage
records.

| Surface | Field | Values |
|---|---|---|
| CLI `--json` | `verdict` (top level) | the gate-plane vocabulary every plane's `--json` uses: `pass` · `errors` · `not-verified` · `usage-error` |
| CLI `--json` | `gate.verdict` | the settled-verdict vocabulary: `pass` · `fail` · `not-verified` |
| MCP | `verdict` | the settled-verdict vocabulary, from the engine's `registryLifecycleVerdict`: `pass` · `fail` · `not-verified` |

So a missing remover reads `errors` at the CLI top level, and `fail` in
`gate.verdict` and over MCP. The CLI's `verdictReason` comes from the settled
envelope:

- at exit `2`: the shortfalls;
- at exit `1`: the engine's failure reason, plus any "also not verified";
- at exit `0`: the acceptance lines, or nothing.

A pass never carries a not-verified reason.

## A config that fails to load

An existing `sharkcraft.config.ts` can fail to load: a schema error, a bad
`$use`, or an import failure. Then `registryLifecycle.skipDirs` /
`skipDirsAdd` were never applied. The scan still runs with the default skip
set, but:

- the report carries `configCoverage` (`1` config file expected, `0`
  examined) and a warning line;
- the settled exit is `2`, never `0`. `--allow-empty` does not waive it.
- a missing remover found anyway is still `1`, with an `(also not verified: …)`
  line.

The CLI verbs and the MCP tool (via `inspection.configLoadError`) behave the
same. Run `shrk doctor` to see the load error.
