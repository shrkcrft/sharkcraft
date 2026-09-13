/**
 * How a consumer asks the injected command resolver to read ONE string.
 *
 * `assumeShrk` — the string is a shrk COMMAND REFERENCE, not free shell text:
 * a knowledge `command` reference or anchor, an agent test's
 * `expectedCommands`, anything resolved as the `command` reference kind. A
 * bare command-word head (`doctor`, `frobnicate zzz`) is then read as
 * `shrk <…>` — so `doctor` resolves and `frobnicate` is an unknown verb —
 * unless the head is not a shrk verb but a package manager or a known
 * executable (`bun test`, `git status`), which stays `not-shrk`.
 *
 * Free-text sites (playbook steps, pipeline `cliCommands`, routing-hint
 * commands) leave it unset: a bare `pytest -q` there is a shell command, not a
 * dead shrk verb.
 *
 * The reading is decided in exactly one place — the CLI's command-string
 * resolver — and every consumer asks for it through
 * `resolveShrkCommandReference`, so knowledge-stale, the self-config doctor and
 * the agent-test runner cannot give two answers for the same string.
 */
export interface ICommandResolveOptions {
  readonly assumeShrk?: boolean;
}
