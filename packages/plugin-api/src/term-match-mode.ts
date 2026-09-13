/**
 * How a routing hint's / playbook's trigger words are matched against a task.
 *
 * - `tokens` (the default) — both sides are lowercased and split into terms
 *   on anything that is not a letter or digit (so `capability-pack`,
 *   `capability pack` and `capability_pack` are the same needle), and the
 *   needle's terms must appear CONTIGUOUSLY in the task, each equal or one
 *   plain inflection apart (`gate` ~ `gates`, `refactor` ~ `refactoring`).
 *   `ci` no longer fires inside `pricing`, nor `gate` inside `investigate`.
 * - `substring` — the legacy raw `task.toLowerCase().includes(needle)`. Opt in
 *   per hint when infix matching is wanted (`auth` inside `authentication`);
 *   the loader warns on any needle shorter than 4 characters in this mode.
 *
 * Authored as plain data, so the hint/playbook field also accepts the string
 * values (`mode: 'substring'`).
 */
export enum TermMatchMode {
  Tokens = 'tokens',
  Substring = 'substring',
}
