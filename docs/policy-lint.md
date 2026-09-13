# Policy lint (the template / style / TS content plane)

Some defects compile AOT-green because they live on surfaces the type checker
and structural search can't see:

- raw markup in `.html` files (excluded from source indexing) and **inline
  `template:` strings** (an opaque string to the compiler);
- stylesheet content;
- a handful of AOT-invisible TS shapes a project wants to forbid.

`shrk policy-lint` runs **deterministic, data-defined pattern rules** over
exactly those surfaces. No AI, no framework knowledge — a project supplies the
rules as data in `sharkcraft.config.ts` `policyRules[]` (or a pack). The
headline capability is that it **reads `.html` files and extracts inline
`template:` bodies** (with correct source line numbers), so a rule can flag, for
example, raw markup when a shared primitive should be used.

## The model

Each rule names a **surface**, a **regex**, and a human **message** (optionally a
suggested replacement). Every match becomes a finding at its real `file:line`.

| surface | what it scans |
|---|---|
| `template` | `.html`/`.htm` files (whole) **plus** inline `template:` strings extracted from `.ts`/`.tsx` (mapped back to source lines) |
| `style` | stylesheet files (`.css`/`.scss`/`.sass`/`.less`/`.styl`) |
| `ts` | source files — for AOT-invisible shapes you want to forbid |

## Configuring rules

```ts
export default defineSharkCraftConfig({
  policyRules: [
    {
      id: 'no-raw-button',
      surface: 'template',
      // pattern is a regex; capture group 1 (if present) is the reported token,
      // otherwise the whole match is.
      pattern: '<button\\b',
      message: 'Raw <button> — use the shared button primitive.',
      suggest: 'Import and use the shared <Button> component instead.',
      severity: 'error', // 'error' (default) fails; 'warning' reports only
    },
    {
      id: 'no-deep-selector',
      surface: 'style',
      pattern: '::ng-deep|/deep/',
      message: 'Deep selectors leak styles across component boundaries.',
    },
  ],
});
```

Field reference:

| field | meaning |
|---|---|
| `id` | stable id, shown in findings and selectable with `--only` |
| `surface` | `template` \| `style` \| `ts` |
| `files` | optional project-relative globs; defaults to the surface's file set. A leading `!` EXCLUDES (`['src/**/*.ts', '!src/**/*.spec.ts']`: the spec files are out of scope, never scanned); at least one inclusion glob is required — a negation-only list is a load error, never "the surface defaults minus these" |
| `pattern` | regex source; capture group 1 = reported token (else the whole match). `g` is always applied; add more via `flags` |
| `flags` | extra regex flags (`i`, `m`, `s`) |
| `message` | what's wrong |
| `suggest` | optional remediation (e.g. the primitive to use instead) |
| `severity` | `error` (default, fails) or `warning` |

## Running it

```bash
shrk policy-lint                       # all rules, all surfaces
shrk policy-lint --surface template    # only template-surface rules
shrk policy-lint --changed-only        # only rules touched by the change set
shrk policy-lint --only id1,id2        # only the named rules
shrk policy-lint --json                # machine-readable (schema: sharkcraft.policy-lint/v1)
```

Exit code is `1` when any `error`-severity rule matches, `2` when the run
evaluated nothing (see below), `0` otherwise.

## Scan zones — seeing past comments and into strings

`scan` narrows a rule to one lexical zone of the file. The default is `all`
(a plain text scan, the historical behaviour):

| `scan` | Counts a hit in | Use for |
|---|---|---|
| `all` (default) | every byte | a rule where zone doesn't matter |
| `code` | executable code only | killing the dominant false positive — a hit inside a "we used to do this" comment |
| `strings` | string / template literals only | exactly what a language-scoped linter cannot see (an inline template, an embedded query) |
| `comments` | comments only | forbidden content in the prose itself (a leaked token, a stale directive) |
| `code-and-templates` | code **plus** backtick-template bodies | a construct that legitimately lives in an embedded DSL — an inline `template:`, a SQL/GraphQL tagged literal — where bare `code` would blank the very thing you are matching |

The same `scan` vocabulary applies to the [extraction DSL](extraction-dsl.md),
so a rule author who learns it here does not meet a differently-named field one
plane over.

Zoning is lexical and C/JS-family (`'`/`"`/`` ` `` strings, `//` and block
comments), designed for the `ts` and `style` surfaces. It is **not** applied to
inline-template units, whose content is already a string body. A regex literal
in expression position is one opaque code span — its quotes, backticks and
`/*` open nothing (round 11); a regex right after `)` (`if (x) /re/`) is read
as a division — an explicit, documented limit.

## Exemptions are first-class, and visible

| Field | Effect |
|---|---|
| `exemptFiles` | project-relative globs whose hits are dropped — plain globs only (a `!` here would mean "exempt everything else", and is a load error) |
| `exemptLines` | a marker substring (e.g. `policy-allow:no-nondeterminism`); a hit on that line **or the line above** is dropped |

**`files` `!` vs `exemptFiles`.** A `!` entry in `files` EXCLUDES: the file is
out of the rule's scope, nothing in it is scanned or reported. `exemptFiles`
MARKS: the file is still scanned and its hits are reported as suppressed. Use
`!` for files the rule is not about (tests, fixtures); use `exemptFiles` for a
known exception you want to keep visible.

A legitimate exception is config, not something to grep around. Crucially,
exempted hits are **reported as suppressed, not deleted** — a silently-dropped
exemption is indistinguishable from a stale glob, which is the failure this
plane exists to prevent:

```bash
shrk policy-lint explain <ruleId>
```

```
Hits that COUNT (0):

Hits an exemption DROPPED (18):
  – require('node:  (packages/ai/src/__tests__/provider-resolver.test.ts:89)  via exemptFiles
  – require('node:  (packages/inspector/src/import-hygiene.ts:227)  via scanZone
```

## Rules that scan nothing

A rule whose globs match 0 content units is `skipped`, and `policy-lint` returns
`2` (not verified) rather than a green `0`. `failOnEmpty: true` promotes that to
a failure — see [the loud-skip contract](./gate-rules.md#the-loud-skip-contract)
and [`shrk gates coverage`](./gate-rules.md), which audits every plane at once.

## Self-tests

A `selfTest` on a policy rule asserts on its **pattern matches**
(`shrk gates coverage` evaluates it; `shrk gates try` evaluates a candidate's):

- an **id** is what the engine reports per hit — capture group 1 when the
  pattern has one, else the whole match (whitespace-collapsed, at most 120
  chars) — over the hits that COUNT **and** the hits an `exemptFiles` /
  `exemptLines` exemption let through;
- a hit the rule's own `scan` zone dropped (a comment, a string) is **not** an
  id: the zone says that text is prose, and letting it satisfy `expectIds` would
  be the false signal zones exist to remove;
- `expectMatchesAtLeast` counts **content units scanned** (files, or inline
  template bodies) — it guards the glob, not the pattern.

That makes an exempted fixture file the rule's liveness pin:

```ts
{
  id: 'no-legacy-call',
  surface: 'ts',
  pattern: "legacyCall\\(['\"]([a-z]+)['\"]",
  exemptFiles: ['src/fixtures/**'],   // src/fixtures/legacy.ts: legacyCall('boom');
  selfTest: { expectIds: ['boom'] },  // fails the day the pattern stops biting
  message: 'legacyCall is gone — use newCall',
}
```

Before round 11 the ids were always empty on this plane: every `expectIds`
failed forever, and every `expectNotIds` passed forever.

`shrk gates scaffold-selftest` pins **only exempted hits** here, never a live
finding. A finding is debt, and an `expectIds` anchored on it would fail the
gate once the debt is paid. With no exempted hit it scaffolds `expectIds: []`
and says to add an exempted fixture file.

## Authoring patterns safely

- An **uncompilable pattern / bad `flags`** is caught at config-load time
  (`shrk doctor` + the loader name the exact `policyRules[n].pattern` location)
  and never crashes the command.
- Keep patterns anchored/narrow; avoid catastrophic nested quantifiers — the
  pattern runs over file contents. Files larger than ~1 MB are skipped.
- The `template` surface's inline extraction is a deterministic regex over
  `template:` literals (it does not follow `templateUrl` — the referenced
  `.html` is scanned directly).
