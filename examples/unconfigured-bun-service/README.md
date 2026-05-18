# unconfigured-bun-service

A tiny Bun + TypeScript service used as a **dogfood target** for `shrk onboard`.

Intentionally has:
- No `sharkcraft/` folder.
- A handful of `src/services/*.service.ts` files.
- A few `src/utils/*.util.ts` files.
- Some `tests/*.spec.ts` files.
- `package.json` scripts: `test`, `typecheck`, `lint`, `build`.

Try:

```bash
bun run shrk --cwd examples/unconfigured-bun-service onboard --dry-run
bun run shrk --cwd examples/unconfigured-bun-service onboard --write-drafts
```

The `--write-drafts` run materializes advisory drafts under
`sharkcraft/onboarding/`. It never overwrites `rules.ts`, `paths.ts`, or
`templates.ts` — adopting drafts is always a manual step.
