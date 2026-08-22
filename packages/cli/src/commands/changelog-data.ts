/**
 * Machine-readable command-SURFACE delta, shipped inside the binary so
 * `shrk changelog` is authoritative for the exact build in use and works
 * offline. This is NOT the full human CHANGELOG.md — it records only the delta
 * an agent needs to re-orient after an upgrade: which verbs/flags were added,
 * which changed behavior, which were removed. Keep it in sync with CHANGELOG.md
 * when a release lands; the version keys must match `SHARKCRAFT_VERSION`.
 *
 * Ordered oldest → newest; the renderer sorts as needed.
 */

/** One version's command-surface delta. */
export interface IReleaseSurfaceDelta {
  /** Exact release version, e.g. `0.1.0-alpha.24`. */
  readonly version: string;
  /** One-line headline for the release. */
  readonly title: string;
  /** New verbs / flags this version introduced. */
  readonly added: readonly string[];
  /** Verbs / flags whose behavior or defaults changed. */
  readonly changed: readonly string[];
  /** Verbs / flags removed or renamed away. */
  readonly removed: readonly string[];
}

export const RELEASE_SURFACE_DELTAS: readonly IReleaseSurfaceDelta[] = [
  {
    version: '0.1.0-alpha.23',
    title: 'Correctness, gate trust, security & pack-distributable invariants',
    added: [
      '`shrk registry <name> list | exists <id> | where <id>` — declarable registry inventory (pack-distributable).',
      '`shrk policy run --changed-only` / `--since` — finding-diff-scoped policy runs.',
      '`shrk search tuning explain` — why a query ranked the way it did.',
    ],
    changed: [
      '`graph context`/`search`/`callers`/`impact` report a true `total` + `truncated` instead of a silent per-file cap.',
      'Incremental reindex no longer drops inbound edges; renamed barrel re-exports (`export { X as Y }`) now resolve.',
    ],
    removed: [],
  },
  {
    version: '0.1.0-alpha.24',
    title: 'Runtime wiring, write-safety & the author loop',
    added: [
      '`shrk wiring chain | unprovided | orphans` — the registration/DI graph beside the import graph.',
      '`shrk wiring test <candidate>` / `shrk check wiring --explain <ruleId>` — declared vs registered set, no config write.',
      '`shrk trace "<literal>"` — generalize registry tracing to any cross-layer string contract.',
      '`shrk check orphans [--since <ref>] [--staged]` — first-class diff-robust reverse-closure.',
      '`shrk finish` (a.k.a. `review --run`) — one changed-only "safe to finish?" verdict.',
      '`--limit N` (`--limit 0` = all) on graph read commands (default 50).',
    ],
    changed: [
      '`shrk impact --deleted` no longer ENOBUFS — the git diff is streamed via a shared `runGitLines`.',
      'Pack-health scores quality (resolved cross-refs, runnable verification), not mere presence.',
      '`compress --type code` is a real strategy (was markdown-only).',
    ],
    removed: [],
  },
  {
    version: '0.1.0-alpha.25',
    title: 'Earned & change-attributable verdicts',
    added: [
      '`shrk changelog [--since <version>] [--all] [--json]` — the command-surface delta of the running build.',
      '`shrk registry <name> exists <id> --fail-if-taken | --fail-if-missing` — guard-mode exit codes for pre-author checks.',
      '`shrk registry <name> exists <id> --resolve` — map a synonym to the canonical id (registry `aliases`) before the test.',
      '`shrk check registry-lifecycle --changed-only` — diff-scoped lifecycle check that terminates in seconds.',
      '`shrk gen --typecheck` — compile the emitted file set against the detected tsconfig as a PRE-WRITE gate (a template bug fails at generation and REFUSES the write; nothing lands on disk).',
      '`shrk gen --print` — inspect the rendered file bodies in one step (alias of `--show-content`).',
      '`shrk graph cycles --include-type-edges` — opt back into counting type-only import edges.',
      '`shrk context` / `shrk task --summary` (`--brief`) — the terse orientation view (now opt-in).',
    ],
    changed: [
      '`shrk check wiring --changed-only` never renders a green verdict over 0 evaluated rules; reports `M of N (K skipped)`.',
      '`shrk check registry-lifecycle` no longer hangs — bounded scan + wall-clock budget + partial-result flush; skip-dirs are configurable via `registryLifecycle.skipDirs`.',
      'Cycle detection excludes type-only import edges by default (clears phantom architecture reds).',
      '`shrk gate` is change-scoped by default — reds only on change-introduced findings; baseline debt is a non-blocking bucket.',
      '`shrk context` / `shrk task` render the FULL body by default (parity with why/reuse/knowledge get).',
      '`shrk reuse` applies a confidence floor (weak keyword collisions → did-you-mean, score exposed) and shows the consumer total.',
      '`compress --type code` labels its lossy fidelity (banner + JSON `fidelity`).',
      '`changes summary` attributes areas from the declared layer/area taxonomy instead of bucketing to `unknown`.',
      '`smart-context "<task>"` accepts `--task`, and fails loud (banner) when the local model is degraded instead of returning a stale guide dump.',
    ],
    removed: [],
  },
  {
    version: '0.1.0-alpha.26',
    title: 'Honest exit codes',
    added: [
      'A unified exit-code contract across every gate/verify/check verb: `0` verified pass, `1` failure, `2` NOT-verified (empty scope / degraded / timeout). See docs/exit-codes.md.',
      'Global `--strict` — promote a NOT-verified (`2`) verdict to a failure-class nonzero (`1`) across every gate, for a hard CI gate in one switch.',
      '`shrk gate baseline --refreeze` — re-freeze the architecture baseline to the current state (operational reset).',
      '`shrk check wiring --base <ref>` (synonym of `--since`); `check wiring` now shows the rule ids selected by footprint under a scoped run.',
      '`shrk reuse … --all` — the full candidate catalog (default is now a scored top-K did-you-mean).',
    ],
    changed: [
      '`shrk check wiring` (0 rules evaluated) and `shrk registry lifecycle` / `check registry-lifecycle` (0 registrations, or wall-clock timeout) now exit `2` (NOT verified), not a green `0` a chained `&& next` would march past.',
      'The graph/query family (`graph cycles|hubs|callers|impact|search|context|…`) rejects an unknown/misspelled flag (`unknown option --x`, exit `2`) instead of silently swallowing it as a confident success.',
      'Piping any streaming list (`… | head`, `| grep`) no longer crashes with `write EPIPE` — a downstream early-close is swallowed and the real exit code is preserved.',
      '`shrk check wiring --help` documents its own scoping flags instead of running the bare check.',
      '`shrk reuse "<intent>"` returns a scored top-K did-you-mean (score per row) on a weak/no-match intent instead of dumping the whole catalog.',
      '`shrk registry <name> exists <id> --resolve` also normalizes (case-fold, singular/plural, suffix strip/append), not just the declared `aliases` map.',
      '`shrk compress` prints a `fidelity: lossy|lossless|passthrough` banner on the human text path (parity with `--json`).',
      '`shrk changes summary` ships a built-in config/tooling area for non-lib paths — only genuinely unclassifiable files stay `unknown`.',
      '`shrk gen` saved plans persist the rendered file `body` + a per-entry `sha256` digest (reviewable/diffable/re-appliable), not just `sizeBytes`.',
      '`shrk gate` counts only change-attributable (diff-vs-HEAD) architecture errors as blocking; stale-baseline drift in untouched files is informational.',
    ],
    removed: [],
  },
  {
    version: '0.1.0-alpha.27',
    title: 'Runtime-wiring queries, the composite finish verdict & pipe-safe exit codes',
    added: [
      '`shrk wiring unprovided | orphans --changed-only | --base <ref>` — scope the DI/registration-graph verdict to the changeset (the silent-at-runtime tokens THIS change left unprovided); an empty changed scope exits `2` (NOT verified), never a green `0`.',
      '`shrk finish` returns an honest `0`/`1`/`2` (0 pass · 1 fail · 2 not-verified) and now runs two more sub-gates over tracked AND untracked changes: `unprovided` (the DI-graph gate — diff-aware, so it also catches a DELETED provider that leaves a token silently unresolved) and an advisory `arch` (does a changed file sit in a runtime import cycle).',
      'Global `--exit-trailer` — print the final verdict as the LAST stderr line (`shrk-exit: <code>`) so a piped gate’s exit survives `| head` / `| grep` (which report the downstream command’s `$?`).',
      '`shrk trace literal "<string>"` classifies a distinct `render`/handle role, completing the declare → register → consume → render chain; a bare `trace "<literal>"` with no fuzzy match now hints the `trace literal` form.',
      'MCP: `get_wiring_graph` — the read-only registration/DI-graph query (unprovided / orphans / chain) exposed to agents, mirroring `shrk wiring` without a shell-out.',
    ],
    changed: [
      '`shrk finish` no longer paints a green `0` when it evaluated NOTHING — a markdown-only change or an empty scope is now `2` (not-verified). Only deciding (non-advisory) gates set the verdict; a change to non-code files skips the boundary/import/wiring gates loudly instead of trivially passing.',
      'Any gate/verify verb whose stdout is piped prints a one-line stderr note when a NON-zero exit would otherwise be masked by the downstream command’s `$?` (a masked `0`→`0` is harmless, so the note is reserved for a real `1`/`2`).',
      '`shrk help <unknown-topic>` errors to stderr with a nearest-topic did-you-mean and a nonzero exit, instead of re-printing the whole command list re-prefixed with the bogus topic (false self-discovery).',
      '`shrk registry <name> exists <id> --resolve` chains normalization strategies (plural-strip THEN suffix strip/append) so a doubly-off noun (`buttons` → `button` → `button-command`) resolves instead of no-op’ing.',
      'Cycle detection’s type-only exclusion is verified end-to-end from real `import type` source (not just synthetic edges): a pure interface↔interface loop is `0` runtime cycles by default and `1` under `--include-type-edges`.',
      '`shrk finish`’s import-hygiene sub-gate no longer false-fails on a changed TEST file whose fixture strings contain import-like text — the explicit-files path now applies the same `__tests__`/`__fixtures__` exclusion `check imports` already used (both paths share one rule).',
      '`shrk wiring unprovided|orphans` reject a bad `--base <ref>` with a distinct error (not a silent empty "nothing changed" scope), and exclude SHRK’s own `.sharkcraft/` writes so a clean tree with `--changed-only` reads as not-verified (`2`), never a false green.',
    ],
    removed: [],
  },
  {
    version: '0.1.0-alpha.28',
    title: "The plane the compiler can't see — six data-defined gate planes on one extraction DSL",
    added: [
      '`shrk gates list | coverage | explain <id>` — the rule-authoring trust layer across EVERY data-defined plane (wiring / policy / registry / registration / baseline / generated). `coverage` is the stale-selector detector: it reports what each rule actually MATCHED and flags every rule matching 0, so a rule quietly dying is itself a CI failure.',
      '`shrk baseline list | check | diff | update | explain` — the committed-ledger drift engine (`baselines[]`). TWO-WAY by default: a silently LOST entry fails exactly like a gained one. `update` is a separate, explicit bless verb.',
      '`shrk generated list | check | update | explain` — generated-artifact drift + provenance (`generatedArtifacts[]`). Regenerates into a temp dir and diffs BOTH ways (hand-edited file AND a regen that writes a subset), plus the "do not edit" header contract. `--headers-only` never spawns.',
      '`shrk policy-lint explain <ruleId>` — every hit with file:line, INCLUDING the hits an exemption or the scan zone dropped, each labelled with which one applied.',
      '`shrk registry <name> duplicates` — ids declared in more than one place, with every declaration site (load-order roulette the compiler cannot see).',
      'Extraction DSL on every rule source: `extract` with 9 kinds (`regex-capture`, `array-members`, `object-keys`, `enum-members`, `export-names`, `call-args`, `decorator-args`, `string-union-members`, `json-path`) plus `anchor` / `argIndex` / `capture` and the `match` + `exclude` allow/deny pair.',
      'Wiring relations: `mode: disjoint`, `registeredMode: intersection`, multi-hop `chain`, `{id}` message templating, and `failOnEmpty` / `selfTest` on every plane.',
      'Policy rules: `scan: all|code|strings|comments` (lexical zone classifier), `exemptFiles`, `exemptLines`.',
    ],
    changed: [
      'Loud-skip contract: a rule whose SOURCE side matches 0 files / extracts 0 ids is `skipped` and the check exits `2` (NOT verified), never a green `0`; `failOnEmpty: true` promotes it to `1`. An empty SINK is deliberately NOT a skip — it stays a failure, annotated `emptySink`, so a real total-miss is never downgraded.',
      '`shrk policy-lint` exits `2` when it evaluated nothing, and reports exemption-suppressed hits as a count instead of silently deleting them.',
      "`shrk finish`'s import sub-gate lists only the findings that DRIVE the verdict — allowlisted (`info`) entries no longer pad the capped fix-list and push a real error out of view.",
      'MCP: the pack-helper tool is now `get_pack_helper` (was `get_helper`, which collided with the helper-registry tool and made one of the two unreachable via `tools/call`). Completes the dedup that already renamed `list_helpers` → `list_pack_helpers`.',
      'Pack safety: `baselines[]` / `generatedArtifacts[]` are pack-distributable, but the merge seam DROPS any pack-contributed element declaring a shell command (`compute.run` / `regen`) — mirroring the "pack-contributed verification commands are NOT auto-run" contract.',
    ],
    removed: [],
  },
];
