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
| `files` | optional project-relative globs; defaults to the surface's file set |
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

Exit code is `1` when any `error`-severity rule matches, `0` otherwise.

## Authoring patterns safely

- An **uncompilable pattern / bad `flags`** is caught at config-load time
  (`shrk doctor` + the loader name the exact `policyRules[n].pattern` location)
  and never crashes the command.
- Keep patterns anchored/narrow; avoid catastrophic nested quantifiers — the
  pattern runs over file contents. Files larger than ~1 MB are skipped.
- The `template` surface's inline extraction is a deterministic regex over
  `template:` literals (it does not follow `templateUrl` — the referenced
  `.html` is scanned directly).
