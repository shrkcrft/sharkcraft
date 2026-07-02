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
];
