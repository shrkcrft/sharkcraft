# Safe language command runner (R27)

`shrk languages run` plans (and optionally executes) per-language
test/build/lint/format/check commands.

## Defaults

- **Dry-run by default.** No command is executed without `--execute`.
- **Install / restore commands gated.** They appear in the plan but are
  marked `skipped` unless `--allow-install` is set.
- **Refused outright.** Any inferred command matching `publish`, `deploy`,
  `release`, `push`, `sudo`, `rm -rf /`, or `curl | bash` is refused and
  surfaced in `plan.refusedSteps`.
- **Inferred only.** The runner never resolves user-supplied commands; it
  picks from `buildLanguageCommandReport` (which is itself driven by
  `detectLanguageProfiles`).

## CLI

```bash
shrk languages run                       # dry-run plan for the default test category
shrk languages run --category lint
shrk languages run --command-id java.test
shrk languages run --all-tests --execute # runs every detected test command
shrk languages run --execute --allow-install --report
```

`--report` writes a JSON dump under `.sharkcraft/reports/language-run-<ts>.json`.

## MCP

`get_language_run_plan` is read-only and returns the dry-run plan. It cannot
execute commands.

## Schema

`sharkcraft.language-run-plan/v1`. Fields: `dryRun`, `allowInstall`,
`steps[]` (`{ language, category, command, installLike, skipped? }`),
`refusedSteps[]`, `notes`, and (when `--execute`) `results[]`.
