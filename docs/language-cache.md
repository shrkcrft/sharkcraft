# Language profile cache (R27)

The language detector walks the project tree on every invocation. Large
repos can take seconds. R27 adds an opt-in cache at
`.sharkcraft/languages/cache.json`.

## CLI

```bash
shrk languages detect --cache               # use cache when valid
shrk languages detect --cache --refresh-cache   # rewrite the cache
shrk languages cache status                 # show cache freshness
shrk languages cache clear                  # dry-run (no deletion)
shrk languages cache clear --write          # actually remove the cache
```

`languages detect --cache` returns the cached result when valid, or
recomputes silently when stale (default). Pass `--refresh-cache` to force
recomputation.

## Cache signature

A cache hit requires all of the following to match the live tree:

- Absolute project root.
- SharkCraft version (caller-provided).
- mtime + size of every manifest file we care about
  (`package.json`, `tsconfig.json`, `bun.lockb`, `pnpm-lock.yaml`,
  `yarn.lock`, `package-lock.json`, `pom.xml`, `build.gradle{,.kts}`,
  `settings.gradle{,.kts}`, `pyproject.toml`, `requirements.txt`,
  `setup.py`, `poetry.lock`, `uv.lock`, `go.mod`, `go.sum`, `Cargo.toml`,
  `Cargo.lock`).
- File count + latest mtime per tracked extension
  (`.ts`, `.tsx`, `.js`, `.java`, `.cs`, `.py`, `.go`, `.rs`).

Any drift makes the cache stale; `shrk languages cache status` lists the
reasons.

## MCP

`get_language_cache_status` is read-only and returns the same status
payload.

## Schema

`sharkcraft.language-cache/v1`. Fields: `signature`, `report`, `cachedAt`.

## Safety

- Cache is the only write target; `clear` is dry-run by default.
- No network, no telemetry, no embeddings.
