# Command discovery & did-you-mean

R31 adds typo-tolerant command discovery so users stop grepping `main.ts`
to find a command.

## Commands

```bash
shrk commands search  "<query>"   [--json]
shrk help "<command>"                        # what a command does, its usage and subverbs (`commands explain` was removed)
shrk explain "<topic-or-rule-id>" [--json]   # the knowledge / rule topic explainer — it never describes a command

shrk commands profile             # list surface profiles + how many each hides
shrk commands profile <id>        # render the catalog as that profile sees it
shrk commands --profile <id>      # same curated view as a flag (e.g. agent)

shrk help <group>           # lists nested subcommands for the group
shrk <group> --help         # same effect
shrk <path> [...] --help    # help for the deepest known path — anywhere before `--`
```

Unknown top-level commands, unknown subcommands and unknown flags print a
short "Did you mean: …" block (the CLI `commands suggest` verb was folded into
this; the MCP `suggest_commands` tool remains). The CLI never executes the
suggested command — the human runs it.

## The dispatcher guard (round 11)

Every invocation is judged against what its handler DECLARES — `subverbs`,
`positionals` (`none` / `free` / `path`) and `flags` — before anything runs.
One command index answers "does this subverb exist"; one did-you-mean scorer
(`dispatch/closest-match.ts`) answers "what was meant".

| Invocation | Result |
|---|---|
| `shrk <path> … --help` / `-h`, anywhere before `--` | help for the deepest path the index knows; **nothing runs** (no guard, no inspection, no body) |
| `shrk check rules` — a bare token that is no subverb of a `none` handler | refused before running: the subcommand list, the closest match, and "`rules` is a command of its own" when it is |
| `shrk templates lst` — a bare token under a pure command group | refused (was: group help at exit 0); a bare `shrk templates` still lists its verbs |
| `shrk api-diff status` — a verb-shaped token that is neither a subverb nor an existing file under a `path` handler | "has no `status` verb, and no file named `status` exists", plus the sibling commands that do have that verb. A real file, or any path-shaped token (`.`, `/`, `{…}`, `-`), is never blocked |
| a flag outside a handler's declared `flags` (`gates check --chnged-only`) | refused before running, with the closest accepted flag and the declared set (`Accepts: …`). A declared set unions only the sets along the walked subverbs, so it is per subverb by construction |
| an undeclared handler given a flag no documentation of the group names — usage, the command index, or the ledger of flags its code reads (`shrk check --tag auth`, `shrk baseline update --dry-rn`) | refused **before running**, naming the closest documented flag — nothing is printed or written first. A documented-but-unread flag never changes the exit; presentation flags (`--json`, `--verbose`, `--quiet`, `--no-color`) are warned about only, after the run |
| a VERDICT-VALVE flag (`--fail-on-dead-units`, `--allow-empty`, `--min-referenced`, `--fail-on`) the resolved subverb does not document — only a sibling does (`shrk check --fail-on-dead-units`, `shrk self-config doctor --allow-empty`) | round 13 (K1): refused **before running**, inside the one `judgeInvocation` — nothing is printed first, and the command-string resolver refuses the same string; the message names the subverbs that accept the flag |
| any other flag only a SIBLING subverb documents, which this subverb's run never read | round 13: refused **after the run**, like any dropped flag — a `0` becomes `usageExitFor` on every verb, and on a verdict verb a `2` does too (a found `1` is kept); the message names the subverb that documents it. A sibling-documented flag the run READ is a real input and is never judged |
| a free positional (`task "add a thing"`, `impact src/index.ts`, `graph <assetId>`) | never refused |

The global flags — `--cwd`, `--strict`, `--no-hints`, `--exit-trailer`,
`--compress`, `--ccr`, `--compress-type`, `--compress-query` — are accepted by
every command, leading (`shrk --no-hints scaffolds list`), between the path
tokens, or trailing. Every refusal exits `usageExitFor(path)`: `3` on a verdict
verb, `2` elsewhere (see [exit-codes.md](exit-codes.md)).

A command that adds a subverb or a flag declares it on its handler (and adds a
catalog row); otherwise the guard refuses it, or `commands doctor` reports the
undeclared subverb.

### Flags are documented per subverb (round 13)

A flag is a flag of the subverb that documents it — never of its siblings. An
invocation's documentation is the usages along its declared-subverb walk (the
group's, then the walked subverb's), the command-index entries its path passes
through (`check`, `check templates` for `shrk check templates …` — never `check
boundaries`), and the ledger of flags the group's code reads.

- `shrk check --fail-on-dead-units` ran the whole sweep and exited `0`: only
  `check boundaries` documents the flag, and nothing else reads it. It now exits
  `3` with ``! `shrk check`: --fail-on-dead-units is not a flag of this command —
  only `shrk check boundaries` documents it.`` — before anything runs.
- `shrk registrations list --fail-on-dead-units` (informational) is refused the
  same way: `2` (`usageExitFor` of a non-verdict verb) with the same line — a
  dropped input is never a clean answer, verdict or not.
- **Verdict-valve flags are judged BEFORE the run** (round 13, K1). A valve —
  `--fail-on-dead-units`, `--allow-empty`, `--min-referenced`, `--fail-on`
  (the closed enum `VerdictValveFlag`, `dispatch/verdict-valve-flag.ts`) —
  changes what a verdict's exit MEANS, and its only reader is the subverb that
  documents it. So `judgeInvocation` refuses a valve the resolved subverb does
  not document (its usage, its command-index entry, or its
  `UNDOCUMENTED_FLAG_READS` row) before the body runs, naming the subverbs that
  do accept it — and since the command-string resolver calls the same
  judgement, it refuses the same string (`shrk check --fail-on-dead-units` is
  `unknown-flag`, `shrk check boundaries --fail-on-dead-units` is `ok`).
- Every OTHER sibling-documented flag is judged AFTER the run, and only when
  the run did not read it: whether one subverb's code reads a flag its sibling
  documents (a group's shared option) is not static knowledge, so refusing it
  before the run would refuse real inputs. For those flags the body runs before
  the refusal (the result is refused, not prevented), and the resolver does not
  refuse a string whose only defect is such a flag.

### One refusal format

Every refused flag — the declared-set guard, the documentation refusal, a
verb's own allow-list (`check boundaries`, `reuse coverage`) and the post-run
judgement — is worded by ONE builder (`dispatch/unknown-flag-refusal.ts`):

```
! `shrk gates check`: --fail-on-dead-units is not a flag of this command.
  Accepts: --json, --margin, …          (a command that declares its complete flag set)
  Refused before anything ran — a result that ignored --fail-on-dead-units would not be a pass (exit 3). Run `shrk help gates check` for the flags it accepts.
```

Only the closing sentence changes with the moment: `Refused before anything
ran …`, `The run ignored --x, so its result is refused — not a pass (exit 3).`,
or `The run ignored --x (exit N kept).` There used to be two formats (``Unknown
flag "--x" for `shrk gates check`. Accepts: …`` beside `--x is not a flag of
this command`) for one judgement.

## Curated views (`--profile`)

The full catalog has hundreds of callable commands, many of which are
CI / release / pack-maintenance machinery that is noise for an inline
coding agent. `shrk commands --profile <id>` filters the listing to the
surface a [surface profile](profiles.md) sees — e.g. `--profile agent`
hides interactive verbs plus CI/release/pack-maintenance categories,
leaving the read/scaffold/validate surfaces an agent actually uses.

Hiding is **listing-only** — every command stays fully callable; the
profile just curates what is shown. The view derives its hidden set
mechanically from the catalog (via `packages/cli/src/surface/profiles.ts`),
so it never drifts as commands are added or removed. `--json` emits
`{ profile, total, catalogTotal, hiddenCount, hidden, entries }`.

## `--help` reads the surface (round 11)

`--full-help` and the bare start screen RENDER the surface summary — the same
object `surface list`, `surface explain`, the surface gate and the MCP gate
read — so `surface explain <cmd>` → `visible-in-help` and the help output can
no longer disagree (they used to: help decided from the catalog alone). What
reaches `--help`:

- `surface.hidden` and the active profile's `hidden` (hidden ≠ disabled: the
  command stays callable);
- `surface.disabled`, the deny list (the command also exits 78 when invoked);
- tool-maintenance commands outside SharkCraft's own repository.

`shrk --full-help` lists exactly the commands whose `visibleInHelp` is true
(the rent-paying surface plus the explain / dry-run family);
`shrk --full-help --all` lists every command, annotated `(hidden)` /
`(gated: …)`. A start-screen line whose command is hidden or gated is dropped.
See [surface-tiers.md](surface-tiers.md).

`commands --profile <id>` stays a listing-only view of the catalog; to change
what THIS repository can call, use `surface.disabled` (`shrk surface deny`).

## How matching works

Deterministic Levenshtein + token-fragment scoring (see
`packages/inspector/src/command-suggester.ts`). The score sums:

- exact substring of the full command (10)
- exact / near-match command token (5–8)
- description token match (1–2)

## MCP

- `suggest_commands` — read-only.
- `search_commands` — read-only.
- `explain_command` — read-only.

## Example

```bash
$ shrk templates lst
`shrk templates` has no `lst` subcommand.
  Subcommands: add, doctor, drift, get, lint, list, preview, …
  Did you mean `shrk templates list`?
  Run `shrk help templates` for usage.
$ echo $?
2
```
