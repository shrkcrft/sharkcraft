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
 * Command paths (space-joined top-level + subverb, as {@link extractCommandPath}
 * emits) whose exit code is a HONEST verdict an agent chains on — the set for
 * which a masked exit is a real hazard. Kept deliberately broad over the gate /
 * verify surface; membership only ever gates whether {@link emitPipeExitSignal}
 * may write a one-line stderr note, never behavior.
 */
const GATE_VERB_PATHS: ReadonlySet<string> = new Set([
  'finish',
  'gate',
  'arch',
  'doctor',
  'diff-check',
  'check boundaries',
  'check wiring',
  'check orphans',
  'check policy',
  'check imports',
  'wiring unprovided',
  'wiring orphans',
  'wiring chain',
  'registry',
  'graph why',
  'graph cycles',
]);

/**
 * Is `commandPath` (space-joined, e.g. `check boundaries` / `wiring unprovided`
 * / `finish`) a gate/verify verb whose exit code carries a chained verdict?
 * Matches the exact path, its first-two-token subverb, or its top-level verb —
 * so `check boundaries --json` (2 tokens) and a bare `finish` (1) both resolve.
 */
export function isGateVerb(commandPath: string): boolean {
  if (GATE_VERB_PATHS.has(commandPath)) return true;
  const parts = commandPath.split(' ').filter((p) => p.length > 0);
  if (parts.length >= 2 && GATE_VERB_PATHS.has(`${parts[0]} ${parts[1]}`)) return true;
  if (parts.length >= 1 && GATE_VERB_PATHS.has(parts[0]!)) return true;
  return false;
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
