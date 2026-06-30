# External repo quickstart

A five-minute walk-through for an consumer pointing SharkCraft at their
own repository. Everything below is read-only or writes only into
draft / session / report directories.

## Prerequisites

- Bun ≥ 1.1 on PATH (or a Node-compatible install when SharkCraft is
  published as an npm tarball).
- Your repo cloned locally.

## 1. Tour the surface

```bash
shrk start-here
shrk commands primary
shrk architecture map
```

If you do not yet have a `shrk` shim, run from a local clone with
`bun run shrk …`.

## 2. Onboard the repo

```bash
shrk --cwd ./your-repo onboard --dry-run
shrk --cwd ./your-repo onboard --write-drafts --scaffold-templates
shrk --cwd ./your-repo onboard adopt status
```

Drafts land under `sharkcraft/onboarding/`. SharkCraft never overwrites
`rules.ts`, `paths.ts`, or `templates.ts`.

## 3. Prepare a brief for an agent

```bash
shrk --cwd ./your-repo brief "<your first task>"
shrk --cwd ./your-repo brief "<your first task>" --chunk --output-dir .sharkcraft/briefs/first-task
```

`section-hashes.json` is written next to the chunks so the next call can
do delta comparison.

## 4. Inspect a change

```bash
shrk --cwd ./your-repo impact --since main --format json > impact.json
shrk --cwd ./your-repo review packet --v3 --since main --json > review.json
shrk --cwd ./your-repo report site --output .sharkcraft/reports/site --impact impact.json
```

## 5. Run the readiness gate

```bash
shrk --cwd ./your-repo release readiness
shrk --cwd ./your-repo release readiness --strict --html --report
```

Strict mode warns on missing release notes, limitations, external
quickstart, and CHANGELOG. Consumers typically run lenient until they
ship a release.

## 6. (Optional) Build the demo package

```bash
shrk --cwd ./your-repo demo package --scenario all --output /tmp/demo
shrk --cwd ./your-repo demo package --scenario all --validate
```

## Safety guarantees

- The CLI is the only write path. `shrk gen` is dry-run by default and
  apply requires `--verify-signature` on signed plans.
- MCP tools never write to disk; the dashboard server returns
  GET/HEAD only.
- Pack-contributed verification commands are NOT auto-run.

## Next steps

- Run `shrk brief "<task>"` when a teammate / agent needs to continue
  (R46 removed the legacy `handoff` alias; `brief` is canonical).
- Run `shrk release smoke --scenario governance` after committing a
  SharkCraft change.
- Read [`docs/safety-model.md`](safety-model.md) and
  [`docs/release-readiness.md`](release-readiness.md).
