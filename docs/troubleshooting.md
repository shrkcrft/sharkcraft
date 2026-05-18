# Troubleshooting

Common failure modes when running `shrk` against your repository, and
how to debug them. Start with `shrk doctor` — most issues surface there
first.

## `shrk inspect` / `shrk doctor` exits silently with no output

This was the R51 hang scenario: every `shrk` command against an
external repo returned exit 0 with no output. Root cause was a broken
TS asset in a pack — Bun's dynamic `import()` returns a never-
resolving promise on the second call for a TS file whose first
`import()` rejected at parse time.

R51 fixes this with bounded loading + per-process import dedup. If
you still see a silent exit:

1. Run with `--debug` to see the per-loader timing table:

   ```bash
   shrk --cwd <repo> inspect --debug
   ```

   You'll get one line per asset like:

   ```
   rules    failed   2ms   count=0  /path/to/rules.ts
       error: BuildMessage: "X" has already been declared
   ```

2. Increase the loader timeout if a legitimately large asset is being
   killed:

   ```bash
   shrk --cwd <repo> inspect --loader-timeout 15000
   ```

3. If the failure is cache-induced (e.g. an old cached `failed`
   entry), bypass the cache for one run:

   ```bash
   shrk --cwd <repo> inspect --no-cache --debug
   ```

## Doctor reports `Loader failed (<kind>)`

The bounded loader caught a TS asset that can't be imported. The
error message in the check tells you what went wrong. Common causes:

| Error message | Cause | Fix |
|---|---|---|
| `"X" has already been declared` | A duplicate `export const X` at parse time. | Remove or rename one of the declarations. |
| `Cannot find module …` | A relative import inside the asset is broken. | Fix the import path. |
| `Unexpected token …` | Syntax error. | Run `bun x tsc --noEmit` for a clean error. |
| `timed out after 8000ms: …` | The TS file takes >8s to evaluate. | Split the file, or pass `--loader-timeout`. |

After fixing, the cache invalidates automatically on the next inspect
(mtime/size change).

## Large pack inspection hangs

Previously, very large pack `templates.ts` files (>2000 LOC) were
suspected as a cause of the hang. The actual cause turned out to be a
duplicate `export const` in `rules.ts`. R51 still adds protection for
legitimately large files:

- Files >256 KB are tagged `large` in `loaderDiagnostics`.
- Loaders >1.5s wall-clock are tagged `slow`.
- Both are surfaced by `shrk inspect --debug` and the doctor.

If your pack's TS asset genuinely needs more than 8s to load:

```bash
shrk --cwd <repo> inspect --loader-timeout 30000
```

But that's a smell — consider splitting the file.

## `shrk packs doctor` reports stale signatures

A stale signature means the pack's contribution files have been
modified since the manifest was last HMAC-signed. The engine never
fake-signs. Re-sign with the project's secret:

```bash
SHARKCRAFT_PACK_SECRET="<secret>" \
  shrk packs sign node_modules/@<scope>/<pack>
```

If you don't have the secret, the pack remains stale — `shrk apply`
will refuse to use signed plans from it without `--allow-divergent`.

## MCP tools won't write anything

That's by design. Every MCP tool is read-only and returns a
`nextCommand` hint pointing at the CLI verb the human should run.
This is non-negotiable: see `docs/safety-model.md`.

R51 reinforces this: `inspectSharkcraft({})` now defaults to
`useCache: false` so even the inspector cache is a CLI-only feature.
MCP tools never trigger cache writes.

## Cache files appear in `.sharkcraft/cache/`

R51 added a persistent loader cache under
`<projectRoot>/.sharkcraft/cache/inspector/v1/`. The directory is
already covered by `.sharkcraft/cache/` in `.gitignore`. To delete:

```bash
rm -rf .sharkcraft/cache
```

The next CLI command rebuilds whatever it needs.

## Where to find more help

- `shrk doctor --debug` — full per-loader timing + failure detail.
- `shrk packs doctor --release` — pack-level health check.
- `shrk recommend "<task>"` — find the right CLI verb for a task.
- `shrk commands` — full command catalog.
- `docs/safety-model.md` — read this before disabling safety checks.
- `docs/pack-contributions.md` — what packs can contribute and how
  loaders handle each kind.
