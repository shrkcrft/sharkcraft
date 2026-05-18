# Verbosity vocabulary (R42)

SharkCraft commands accumulate verbosity flags. Without a convention,
new commands invent ad-hoc flags (`--detailed`, `--long`, `--all`,
`--expand`, `--more`, `--with-detail` …). R42 fixes this.

## The convention

| Flag | Meaning | Example |
| --- | --- | --- |
| (no flag) | Shortest human-friendly default. Top 3–5 items + next command + details path. | `shrk recommend "<task>"` |
| `--compact` | Synonym for the default. Declared when a command wants to be explicit. | `shrk recommend "<task>" --compact` |
| `--verbose` | Expanded human output. Still readable in a terminal. | `shrk recommend "<task>" --verbose` |
| `--full` | Complete human output where the long body exists. | `shrk context --task "<task>" --full` |
| `--json` / `--machine-json` | Machine output. The JSON shape is the contract. | `shrk task "<task>" --json` |
| `--format text\|markdown\|html\|json` | Report-style commands only. | `shrk report quality --format html` |
| `--actions-only` | Command/action-focused output (skip prose). | `shrk recommend "<task>" --actions-only` |
| `--commands-first` | Surface command recommendations before context body. | `shrk context --task "<task>" --commands-first` |
| `--legacy` | Old renderer only. Read: "give me the pre-R34 output". | `shrk search "<query>" --legacy` |

## Rules

1. **No synonym proliferation.** A new command must not introduce
   `--detailed`, `--long`, `--more`, `--expand`, `--with-detail`, or
   any other neighbour of `--verbose` / `--full` / `--json`.
2. **`--json` is exhaustive.** It is the only flag that changes the
   contract — JSON-mode output must be valid against the documented
   schema and must not contain prose banners.
3. **`--format` is for report-style commands** (`shrk report …`,
   `shrk pr summary`). It is **not** a substitute for `--json`.
4. **`--legacy` is a kill switch.** Pre-R34 renderers stay reachable
   one flag away while the next-generation renderer matures.
5. **`--full` implies long human body**, not raw data. If a command
   has no long body, omit `--full` and use `--verbose`.
6. **Default outputs target ≤25 lines** for canonical surfaces
   (recommend / context / task / search / doctor / self-config doctor /
   commands explain / explore / changes summary / pr summary).

## Enforcement

`shrk commands ux-check` (R42) warns on:

- `legacy-flag-on-canonical` — a canonical primary surface accepts
  `--legacy` (which signals R34-or-earlier renderer behaviour; banner
  is fine, default isn't).
- Commands that ship a `--detailed` / `--long` / `--expand` /
  `--with-detail` / `--more` flag (heuristic; raises a warning unless
  the command explicitly opts out).

## See also

- `docs/command-entrypoints.md` — canonical first-command answers.
- `docs/start-here.md` — onboarding flows.
- `.sharkcraft/reports/r42-product-surface-audit.md` — the R42 audit
  that motivated this doc.
