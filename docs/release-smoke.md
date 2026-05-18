# Release smoke harness

`shrk release smoke` runs a deterministic, local-only smoke suite against five
canonical scenarios using temp fixtures. It never publishes, never calls the
network, and asserts that no files are written outside `.sharkcraft/`,
`sharkcraft/`, `examples/`, or the fixture's `package.json` / `README.md` /
`tsconfig.json` / `bun.lock`.

```bash
shrk release smoke                           # all five scenarios
shrk release smoke --scenario pr-review      # one scenario
shrk release smoke --report                  # write JSON + Markdown into .sharkcraft/reports/
shrk release smoke --html                    # also write HTML
shrk release smoke --temp-dir /tmp/sc        # explicit temp dir
shrk release smoke --keep-temp               # don't delete fixtures after the run
```

## Scenarios

| Scenario | What it does |
|---|---|
| `unconfigured-repo` | Initialise a minimal Bun/TS fixture, run `onboard --dry-run` + `doctor`. |
| `dev-workflow` | Copy `examples/dogfood-target/`, run `brief` + `doctor`. |
| `pr-review` | Copy dogfood, run `impact --format json`, `report site`. |
| `governance` | Run `quality`, `commands doctor`, `safety audit`, `release readiness`. |
| `pack-authoring` | Initialise an empty fixture, run `packs doctor --release`. |

## What gets reported per step

- exit code
- duration
- artifacts found vs expected
- forbidden artifacts (safe-write violations)
- stdout / stderr tail (on failure)

## MCP

`get_release_smoke_report` returns the *plan* — MCP cannot execute the steps,
so it surfaces the scenarios and asks the caller to run the CLI command.

## Implementation

- `packages/inspector/src/release-smoke.ts`
- `packages/cli/src/commands/release.command.ts` (subcommand)
- `packages/mcp-server/src/tools/release-smoke.tool.ts`
