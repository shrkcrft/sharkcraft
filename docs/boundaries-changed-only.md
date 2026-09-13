# Boundary changed-only mode (R28.1, round 11)

The single most painful thing about `shrk check boundaries` is a
recurring real-world motivation: filtering pre-existing violations so PRs
surface only the new ones. R28 added a changed-scope filter to every
boundary view. Round 11 made it honest about the two things a file filter
cannot see: **a rule edit**, and **a change no rule governs**.

## Commands

```
shrk check boundaries --changed-only
shrk check boundaries --since main
shrk check boundaries --since HEAD~5
shrk check boundaries --staged
shrk check boundaries --files src/a.ts,src/b.ts
shrk check boundaries --polyglot --changed-only
shrk check boundaries --changed-only --no-rule-escalation   # see "Escalation" — exits 2

shrk boundaries enforce --changed-only
shrk architecture violations --changed-only
```

`shrk finish`, `shrk diff-check` and the MCP `get_changed_boundary_report` /
`get_diff_check_report` tools run the SAME changed-scope boundary check —
one orchestrator (`runBoundaryCheck`), so escalation, the tsconfig alias map
and the verdict cannot differ between them.

## Scope resolution

| Flag | Source | Notes |
|---|---|---|
| `--changed-only` | working tree (untracked + modified) | default scope when no other flag set |
| `--since <ref>` | `git diff --name-only <ref>` | use a branch or SHA |
| `--staged` | `git diff --cached --name-only` | pre-commit usage |
| `--files a,b,c` | explicit list | bypasses git entirely |

## Which rules a changeset is accountable for

A rule is **selected** when it GOVERNS a changed source file — a file the
import scan read, inside the rule's `from` globs and not exempt — or when it
is **escalated** (below). A deleted file, a doc, a `.json` edit or a file no
rule's scope covers puts nothing in front of any rule.

- **Nothing selected is an empty selection, not a pass.** `check boundaries
  --changed-only` over a change no rule governs exits **2** ("no changed source
  file is governed by a boundary rule; nothing was checked"). A hook that runs
  on every commit accepts it explicitly with `--allow-empty`. finish reports
  the boundaries sub-gate `skipped` (it used to report `pass` from an error
  count of zero over files no rule looks at).
- **A selected rule carries its coverage.** A rule whose scope glob matched
  nothing (see docs/boundaries.md → dead rules and units) settles the run to
  **2** even when the changed files are clean.

## Escalation: a rule edit is never "legacy"

Tightening a rule creates violations only in files nobody touched — exactly
the violations a file filter used to file as "legacy ignored", so
`--changed-only`, `finish` and `diff-check` read green over the violation the
edit had just introduced. When the changeset touches a rule's definition, the
rule is **escalated**: every violation it produces is reported, whatever its
file.

| Changed file | Escalates |
|---|---|
| a `boundaryFiles` rule file (local or in-repo pack) | the rules it defines |
| `sharkcraft.config.ts` | every rule |
| `tsconfig.json` / `tsconfig.base.json` (the alias map) | every rule |
| the root `package.json` or a lockfile, or a file inside a pack's root | that pack's rules |
| a `--rule-file` candidate | every candidate rule (new by definition) |

It is **stateless**: the diff itself is the signal, so it works on a fresh CI
checkout where a persisted rule-set hash would have no previous value. The
text prints `escalated  N rule(s) — <file> changed (<kind>): evaluated against
the whole tree`; JSON carries `changedScope.escalation { ruleIds, reasons }`.

`--no-rule-escalation` keeps escalated rules out — and the run then reports
them **unexamined**: exit **2**, "changed-only cannot see a rule edit". It is
never a way to turn a rule edit green.

Stale exceptions (docs/boundaries.md → exemptions and exceptions) follow the
same path: keyed on the rule's source file, they fail a changeset that edits
the rule file (or escalates it), and are legacy otherwise.

## JSON shape

```json
{
  "passed": false,
  "exitCode": 1,
  "verdict": "errors",
  "counts": { "error": 1, "warning": 0, "info": 0 },
  "changedScope": {
    "mode": "files",
    "changedFiles": ["sharkcraft/boundaries.ts"],
    "governedFiles": [],
    "includedViolations": [ { "ruleId": "app.no-data", "file": "src/app/a.ts", "line": 1 } ],
    "ignoredLegacyCount": 0,
    "ignoredLegacyByRule": {},
    "escalation": {
      "ruleIds": ["app.no-data"],
      "reasons": [{ "file": "sharkcraft/boundaries.ts", "kind": "rule-source", "ruleIds": ["app.no-data"] }]
    },
    "escalationSuppressed": []
  },
  "gate": { "schema": "sharkcraft.gate/v1", "verb": "check boundaries", "exit": 1 }
}
```

## Exit codes

| Exit | When |
|---|---|
| 0 | at least one selected rule examined its scope and none reported an error violation |
| 1 | an error violation in the changeset (or by an escalated rule), an errored rule, a stale exception, or a `failOnEmpty` rule |
| 2 | an empty selection (nothing governed, nothing changed), a selected rule that checked nothing, a partly-examined scope, or `--no-rule-escalation` suppressing an escalation |
| 3 | an unknown flag, an unknown `--rule`, an unloadable `--rule-file` |

## MCP

`get_changed_boundary_report({ since?, staged?, files?, polyglot? })`
returns the same shape over the read-only MCP surface, plus
`typescript.escalation`, `typescript.verdict` and `typescript.exitCode`.

## Backward compatibility

The default behaviour of `shrk check boundaries` (no scope flags) still
evaluates every rule. What changed in round 11 is honesty: an empty or
ungoverned changeset is `2` instead of `0`, and a rule edit reports its new
violations instead of hiding them as legacy.

## R29: shared changed-scope quality model

R29 generalises the changed-only filter into a shared
`IChangedScopeClassification` (schema `sharkcraft.changed-scope/v1`).
Buckets: `new-in-changed-file | existing-touched |
existing-untouched-hidden | resolved | unknown | unchanged |
out-of-scope`. The same scope flags now work on:

```
shrk policy run --changed-only|--since|--staged|--files
shrk drift --changed-only|--since|--staged|--files
```

Boundary checking continues to use its dedicated filter as a fast path;
the shared classifier is the consistent model the other engines build
on.

See `docs/knowledge-integrity.md` for the related stale-check and
`docs/template-drift.md` for template verification.
