/**
 * The ONE vocabulary for "does this command string resolve?".
 *
 * The command table lives in the CLI package, above this layer, so the
 * inspector never answers the question itself: the CLI builds its command
 * index and injects a resolver through `warmReferenceRegistries(inspection,
 * { commandResolver })`. The CLI resolver (`resolveCommandString`) returns
 * these same members — there is exactly one definition, here.
 *
 *   - `Ok`             — the verb chain dispatches (a trie path, a declared or
 *                        catalog-documented subverb, a meta flag), or
 *                        `<pm> run <x>` names a real package script, or a bare
 *                        MCP tool id names a registered tool.
 *   - `PrefixOnly`     — the verb chain is proven, but the handler dispatches
 *                        its tail internally and the tail cannot be proven from
 *                        the trie + catalog (it may be a free positional).
 *                        Counted, never flagged.
 *   - `UnknownVerb`    — no registered verb matches the first token.
 *   - `UnknownSubverb` — the parent is proven and provably takes no free
 *                        positional, and the next token is not one of its
 *                        subverbs (or a path-mode token is verb-shaped and
 *                        names neither a subverb nor a file).
 *   - `UnknownFlag`    — the verb chain is proven, but the dispatcher refuses a
 *                        flag before anything runs (outside a declared set, or
 *                        named by none of the command's documentation).
 *   - `UnknownScript`  — `<pm> run <x>` and the root package.json has no `x`.
 *   - `UnknownTool`    — a bare MCP-tool-shaped id that no tool registers.
 *   - `NotShrk`        — not a command this engine can check (git, tsc, …).
 *                        Skipped and counted.
 *   - `Unverified`     — no resolver was injected (outside the CLI), so the
 *                        string was NOT checked. Never read as a pass.
 */
export enum CommandResolutionStatus {
  Ok = 'ok',
  PrefixOnly = 'prefix-only',
  UnknownVerb = 'unknown-verb',
  UnknownSubverb = 'unknown-subverb',
  UnknownFlag = 'unknown-flag',
  UnknownScript = 'unknown-script',
  UnknownTool = 'unknown-tool',
  NotShrk = 'not-shrk',
  Unverified = 'unverified',
}
