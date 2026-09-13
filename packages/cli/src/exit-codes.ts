/**
 * The canonical exit-code contract for every gate / verify / check verb.
 *
 * alpha.24 and alpha.25 made the STDOUT verdicts honest ("not verified",
 * "degraded", "0 rules evaluated", "this is not a pass") but left the exit
 * code returning `0` over those same unverified paths. An agent almost never
 * parses the banner — it chains `shrk <cmd> && <next>` on the *exit code*, so a
 * `0` over a "not verified" result marches straight past the gate. This module
 * is the single source of truth so a chained gate can finally tell apart
 * "passed", "failed", and "never ran".
 *
 *   0  VerifiedPass  — checks ran over a NON-EMPTY scope and passed. Never
 *                      returned when zero units were evaluated.
 *   1  Failure       — checks ran and found violations.
 *   2  NotVerified   — indeterminate: empty evaluation scope, all rules
 *                      skipped, degraded fallback, short-circuit, timeout, or
 *                      "refused to run". Distinct from both pass and fail so a
 *                      chain can branch on it (`|| handle-indeterminate`).
 *   3  UsageError    — the request itself was malformed: unloadable config, an
 *                      unknown rule id, a bad flag value. Split out of `2` on
 *                      the GATE verbs because the two demand different
 *                      responses: `2` means "the gate ran but proved nothing"
 *                      (investigate the rules), `3` means "the gate never
 *                      started" (fix the invocation or the config). Non-gate
 *                      verbs keep returning `2` for usage errors — widening the
 *                      split across the whole CLI would churn a documented
 *                      contract far beyond what it buys.
 *
 * The `gen --typecheck` pre-write gate already refuses-to-nonzero rather than
 * emit an unverified artifact; this generalizes that instinct across the gate
 * surface, adding the third code so "unverified" is distinguishable from
 * "broken".
 */
export enum ExitCode {
  VerifiedPass = 0,
  Failure = 1,
  NotVerified = 2,
  UsageError = 3,
}

/**
 * Promote a NotVerified (`2`) exit into a Failure-class nonzero (`1`) when the
 * caller opted into `--strict`. This is the one switch an agent flips to make a
 * hard CI gate treat "unverified" as a failure. Any other code passes through
 * unchanged (a real pass stays `0`, a real failure stays `1`). Applied globally
 * in {@link runCli} after the handler returns, so every gate/verify verb honors
 * `--strict` uniformly without threading the flag through each call site.
 */
export function promoteForStrict(code: number, strict: boolean): number {
  if (strict && code === ExitCode.NotVerified) return ExitCode.Failure;
  return code;
}

/**
 * True when the argv carries a global `--strict` (bare or `--strict=<level>`).
 * `--strict` is also an established per-command flag (e.g. `check --strict`,
 * `doctor --strict=warnings`) whose local meaning is preserved — this global
 * layer only adds the NotVerified→Failure promotion on top, and only affects a
 * command that actually returned `2`.
 */
export function argvHasStrict(argv: readonly string[]): boolean {
  for (const t of argv) {
    if (t === '--') break;
    if (t === '--strict' || t.startsWith('--strict=')) return true;
  }
  return false;
}

/**
 * True when the argv carries the global `--exit-trailer` (before the `--`
 * sentinel). This is the machine channel that survives a pipe: when set, the
 * final verdict is written as the LAST stderr line (`shrk-exit: <code>`), so an
 * agent that pipes a gate to `head`/`grep` can still read shrk's real exit off a
 * channel the pipe can't swallow. See {@link emitPipeExitSignal}.
 */
export function argvHasExitTrailer(argv: readonly string[]): boolean {
  for (const t of argv) {
    if (t === '--') break;
    if (t === '--exit-trailer') return true;
  }
  return false;
}

/**
 * THE verdict-verb registry: command paths (space-joined, as `runCli` derives
 * them with `extractCommandPath(argv, VERDICT_PATH_TOKENS)` — at most THREE
 * leading positional tokens) whose exit code is an HONEST verdict an agent
 * chains on — the set for which a masked exit is a real hazard.
 *
 * Register the SHORTEST path that is a verdict and nothing wider: `docs
 * references check` is three tokens because its siblings `docs references
 * list` / `explain` are informational, and registering `docs references` would
 * make them verdict verbs too (the trailer would print `shrk-exit: 0` for a
 * listing). A two-token entry covers every deeper path under it.
 *
 * Membership enables {@link emitPipeExitSignal}'s stderr note and the
 * `--exit-trailer` line, never behaviour. It is also the list the round-11
 * contract test iterates: every entry must have a row in
 * `r75-verdict-coverage-contract.test.ts`, every verb that builds a gate
 * envelope must be in here, and every CLI file that settles a verdict through
 * `settleVerdict(` names its verbs (each registered) or a reasoned exemption in
 * that test's two-way settle-site ledger. A NEW verdict verb therefore adds itself here, or
 * CI fails — the registry and the contract cannot drift apart.
 */
export const GATE_VERB_PATHS: ReadonlySet<string> = new Set([
  'finish',
  'gate',
  'arch',
  'doctor',
  'diff-check',
  // Bare `shrk check` — the SharkCraft-level sweep (doctor / knowledge /
  // templates / pipelines / packs / action hints) settles 0/1/2 through
  // settleVerdict; a doctor shortfall is 2 (round 11). Every `check` subverb is
  // a verdict as well (it has no list/explain siblings), so the one-token entry
  // is the shortest verdict path and misclassifies nothing. The `check <plane>`
  // entries stay because the contract matrix records which emit the envelope.
  'check',
  'check boundaries',
  'check wiring',
  'check orphans',
  'check imports',
  'check registry-lifecycle',
  'wiring unprovided',
  'wiring orphans',
  'wiring chain',
  'registry',
  // The lifecycle subverb emits the settled gate envelope (the MATRIX row says
  // so precisely); `registry <name> exists|where|duplicates` keep the plain
  // exit contract under the `registry` entry above.
  'registry lifecycle',
  'graph why',
  'graph cycles',
  // The data-defined gate verbs, the aggregate, and the corpus check — each
  // exits 0/1/2/3 on purpose, and until round 11 none of them honoured
  // `--exit-trailer`, although they are the verbs most often piped in CI.
  'gates check',
  'gates coverage',
  'quality',
  'policy-lint',
  'baseline check',
  // The bless step (round 11): a value computed from an incomplete read (a file
  // over the read cap) is refused and the run settles 2 — a refusal a pipe must
  // not mask. Its siblings `list` / `diff` / `explain` are informational, so the
  // entry is two tokens, never `baseline`.
  'baseline update',
  'generated check',
  'docs references check',
  'knowledge stale-check',
  'knowledge verify',
  // Curated reusePrimitives[] vs the public export surface (round 11 §2.4).
  'reuse coverage',
  // Helper files loaded + validated — 0/1/2 (+ --allow-empty) (round 11 §3.6).
  'helper doctor',
  // The self-config and asset doctors (round 11 §1.3 / §1.6): 0 pass · 1
  // errors (or warnings under --strict, dead units under --fail-on-dead-units)
  // · 2 a dead selector or an unverifiable unit — settled against coverage.
  'self-config doctor',
  // Broken self-config references (round 11 review): 0 none · 1 a broken
  // reference · 2 an id that could not be looked up — settled through
  // settleVerdict; its `2` must survive a pipe, and a bad flag is `3`.
  'self-config broken-links',
  // Round 13 (lane A): the report writer settles THE self-config verdict
  // (`self-config doctor`'s, --strict / --fail-on-dead-units included) — its
  // `2` must survive a pipe, and a bad flag is `3`, never that `2`.
  'self-config report',
  'registrations doctor',
  'scaffolds doctor',
  'search tuning doctor',
  // The pack + template verdicts (round 11 §1.4 / §3.2 / §3.3): each settles
  // against its coverage (packs discovered, TS files type-checked, compiled
  // artifacts with a build record, templates whose operations were checked),
  // so a `2` is real and must survive a pipe.
  'packs doctor',
  'packs release-check',
  'packs signature-status',
  'packs test',
  'templates doctor',
  // The custom-checks and conventions doctors (round 11 §3.2 / §4.6): 0
  // validated · 1 a declaration that can never run (or a warning under
  // --strict) · 2 nothing declared (--allow-empty) or a file never read.
  'checks doctor',
  'conventions doctor',
  // Round 13: `conventions check` settles through the gate envelope — 0 no
  // error-severity hit · 1 an error-severity hit · 2 no file in scope, no
  // convention declared (--allow-empty accepts either) or a convention file
  // never read. It printed "ok — no violations" at 0 over an empty scope.
  'conventions check',
  // Agent-contract and context tests (round 11, doctor lane): 0 every test
  // passed · 1 a test failed · 2 a test could not be evaluated, or none are
  // configured (--allow-empty accepts that) · 3 an `--id` that selects nothing.
  'test agent',
  'test context',
  // The rule-authoring REPL (round 11, dispatcher lane): 0 the candidate's
  // selfTest held · 1 an expectation failed · 2 the candidate could not be
  // evaluated · 3 a malformed spec or an unknown flag.
  'gates try',
  // The selfTest scaffolder (round 11 review): it refuses to scaffold from a
  // count read off an incomplete scan and settles 2 (settleVerdict) — like
  // `baseline update`, a refusal a pipe must not mask. Its siblings `list` /
  // `explain` are informational, so the entry is two tokens.
  'gates scaffold-selftest',
  // Round 11 review (R11-GAP-5 / R11-GAP-3): verdict-shaped verbs this round
  // changed. Each exits a code an agent chains on, so it must survive a pipe
  // (`--exit-trailer`) and must never collide with a usage error (now 3):
  //   - `boundaries suggest`: 2 over zero rules (nothing was checked);
  //   - `packs contributions`: 1 on an error-severity conflict (a contribution
  //     file that failed to load, a duplicate id) or an entry a loader
  //     REJECTED; 2 (round 12) when only references whose kind's registry is
  //     empty or undeclarable remain — settled through settleVerdict;
  //   - `self-config resolve`: 0 resolved · 1 unresolved — a lookup verdict,
  //     like `registry <name> exists`;
  //   - `recommend`: 0 by default and 2 under `--require-confident` when
  //     nothing matched with confidence — registered so a bad flag is 3, never
  //     that 2 (the verdict is flag-keyed, but the collision is not);
  //   - `drift` (and `drift rules --strict`): 1 on an error finding, 2 when a
  //     boundary scope it reads was never fully examined;
  //   - `architecture violations`: 1 on a violation, 2 over zero boundary
  //     rules or an unexamined scope (the boundary orchestrator's verdict);
  //   - `checks list`: 1 on a declaration that can never run, 3 on a `--rule`
  //     naming no rule — its advertised exit contract (the contract test's
  //     "advertises an exit" ledger found it).
  'checks list',
  'boundaries suggest',
  'packs contributions',
  'self-config resolve',
  'recommend',
  'drift',
  'architecture violations',
]);

/**
 * How many leading positional tokens `runCli` reads to decide whether a verb is
 * a verdict verb — the deepest {@link GATE_VERB_PATHS} entry. (Usage logging
 * keeps its own two-token paths; this only feeds {@link emitPipeExitSignal}.)
 */
export const VERDICT_PATH_TOKENS = 3;

/**
 * Is `commandPath` (space-joined, e.g. `check boundaries` / `wiring unprovided`
 * / `finish` / `docs references check`) a gate/verify verb whose exit code
 * carries a chained verdict? Matches the exact path or any of its one-, two- or
 * three-token prefixes — so `check boundaries --json`, a bare `finish` and
 * `graph why a b` all resolve, while `docs references list` does not.
 */
export function isGateVerb(commandPath: string): boolean {
  if (GATE_VERB_PATHS.has(commandPath)) return true;
  const parts = commandPath.split(' ').filter((p) => p.length > 0);
  for (let n = Math.min(parts.length, VERDICT_PATH_TOKENS); n >= 1; n -= 1) {
    if (GATE_VERB_PATHS.has(parts.slice(0, n).join(' '))) return true;
  }
  return false;
}

/**
 * The exit code for a malformed invocation of `commandPath` — an unknown
 * subcommand, an unknown flag, a verb-shaped token that is no subverb and no
 * file, an input the command silently ignored. THE documented split: `3`
 * (UsageError) on a verdict verb, whose `2` must keep meaning "ran but proved
 * nothing"; `2` everywhere else. The dispatcher guard and the post-run
 * unknown-flag detector both read it, so one invocation mistake exits one way.
 */
export function usageExitFor(commandPath: string): number {
  return isGateVerb(commandPath) ? ExitCode.UsageError : ExitCode.NotVerified;
}

/**
 * True when the argv carries the global `--no-hints` (before the `--`
 * sentinel). Suppresses advisory one-liners like the piped-exit note while
 * leaving every real diagnostic — and the `--exit-trailer` machine channel —
 * untouched. For a caller that has already internalised the warning and just
 * wants clean stderr in captured logs.
 */
export function argvHasNoHints(argv: readonly string[]): boolean {
  for (const t of argv) {
    if (t === '--') break;
    if (t === '--no-hints') return true;
  }
  return false;
}

/**
 * Process-lifetime latch for the piped-exit hint. The note is advisory, so it
 * pays rent once: a command that emits several gate verdicts in one process
 * (or a `--watch` loop) should not repeat the same paragraph every cycle.
 */
let pipeHintEmitted = false;

/** Reset the one-time hint latch. Test-only seam. */
export function resetPipeHintLatch(): void {
  pipeHintEmitted = false;
}

/** Injectable surface for {@link emitPipeExitSignal} (isTTY + writer + trailer). */
export interface IPipeExitOptions {
  /** True when shrk's stdout is NOT a terminal (i.e. piped/redirected). */
  readonly piped: boolean;
  /** True when `--exit-trailer` was requested. */
  readonly trailer: boolean;
  /** True when `--no-hints` was requested — suppress the advisory note only. */
  readonly noHints?: boolean;
  /** stderr writer; defaults to `process.stderr.write`. Overridable for tests. */
  readonly write?: (s: string) => void;
}

/**
 * Keep the honest `0`/`1`/`2` exit code READABLE through the shape agents reach
 * for first — the trailing pipe. `<gate> | head` reports `head`'s `$?`, so a true
 * `2` (not-verified) or `1` (failure) evaporates into a `0`. Two channels survive
 * the pipe because both go to stderr:
 *
 *   (a) a one-line WARNING when stdout is piped AND the code is non-zero — a
 *       masked `0`→`0` is harmless, so the note is reserved for the case that
 *       actually loses information (a masked `1`/`2`);
 *   (b) the `shrk-exit: <code>` TRAILER whenever `--exit-trailer` is set (any
 *       code), so a caller that opts in gets the verdict machine-readably.
 *
 * A no-op for non-gate verbs. Called once in {@link runCli} after the final
 * (strict-promoted) code is known, so every gate/verify verb is covered without
 * threading anything through each command.
 */
export function emitPipeExitSignal(
  commandPath: string,
  code: number,
  opts: IPipeExitOptions,
): void {
  if (!isGateVerb(commandPath)) return;
  const write = opts.write ?? ((s: string) => void process.stderr.write(s));
  // Advisory, and therefore rationed: stderr only, only when a NON-zero verdict
  // would actually be lost to the pipe, at most once per process, and never
  // under `--no-hints`. The structured channel (`--exit-trailer`) is unaffected
  // by all of these — it is opt-in and always emitted when asked.
  if (opts.piped && code !== 0 && !opts.noHints && !pipeHintEmitted) {
    pipeHintEmitted = true;
    write(
      `note: stdout is piped — $? reflects the downstream command, not shrk (exit ${code}); ` +
        `use PIPESTATUS[0] or --exit-trailer to read shrk's verdict (--no-hints silences this).\n`,
    );
  }
  // The trailer is written LAST so it is the final stderr line a caller reads.
  if (opts.trailer) write(`shrk-exit: ${code}\n`);
}
