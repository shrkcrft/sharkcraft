# Policy checks

SharkCraft policy checks are deterministic predicates that run against the
current inspection (no AI, no shell, no network). They live in two places:

1. **Local** — `sharkcraft/policies.ts` exports a default array of
   `IPackPolicyCheck` objects.
2. **Packs** — manifest field `contributions.policyCheckFiles`.

## Authoring

```ts
// sharkcraft/policies.ts
const policies = [
  {
    id: 'my.guard.no-secrets-in-config',
    title: 'config.json must not contain credentials',
    severity: 'error',
    checkType: 'path',
    evaluate({ projectRoot, planTargets, bundleAffectedFiles }) {
      const touched = [...planTargets, ...bundleAffectedFiles];
      if (!touched.some((p) => p.endsWith('config.json'))) return true;
      return {
        message: 'config.json appears in plan/bundle targets — verify no secrets are introduced.',
        suggestedFix: 'Move credentials into your secret manager and reference them by env var.',
      };
    },
  },
];

export default policies;
```

Predicates return:
- `true` → passing (no check emitted)
- `false` → failing with the default message
- `{ message, suggestedFix?, context? }` → richer finding

Pack authors can also use the typed helper from `@shrkcrft/plugin-api`:

```ts
import { definePackPolicyCheck } from '@shrkcrft/plugin-api';

export default [
  definePackPolicyCheck({
    id: 'my.guard',
    title: '...',
    severity: 'warning',
    checkType: 'path',
    evaluate({ planTargets, bundleAffectedFiles }) { /* ... */ },
  }),
];
```

The helper is type-only — predicates still need to be pure (no shell, no
network) and snapshot-stable.

## CLI

```bash
shrk policy list                          # all registered checks (local + pack)
shrk policy get <id>                      # registration detail
shrk policy test <id>                     # run only this check against live state
shrk policy test <id> --fixture <dir>     # run against a fixture (planTargets / bundleAffectedFiles)
shrk policy test <id> --input '{"planTargets":["src/x.ts"]}'  # inline JSON
shrk policy test --all --fixture <dir>    # batch-run policies against fixture subdirs
shrk policy run                           # run everything
shrk policy run --bundle <id>             # scope to a bundle
shrk policy run --plan <plan.json>        # scope to a plan
shrk policy run --json                    # machine-readable report
shrk policy check                         # back-compat alias for `run`
```

### Fixture layout

```
fixtures/my.guard/
  policy-input.json     # { projectRoot, planTargets, bundleAffectedFiles }
  expected.json         # { passed?, messageContains?, minSeverity? }
```

`--all --fixture <dir>` iterates over subdirectories whose name matches
the policy id and runs each.

## Safety model

- **Local** policies are trusted by default (you wrote them).
- **Pack** policies must pass `validatePackManifest` to be considered.
- If a pack contributes policy checks but its signature is not `verified`,
  the engine emits an `info`-level warning so the operator notices the
  trust boundary.
- `shrk policy run --require-signed-policy-packs` upgrades that warning to
  a `--no-pack-policies`-equivalent skip with a `warning` finding.
- `shrk policy run --no-pack-policies` skips every pack-contributed check;
  only local policies and the built-in checks (boundary / unsigned-plan /
  pack-signature) run.

There is **no sandbox** in v1: policy `evaluate` runs in the same process
as the CLI. Treat unsigned-pack policy contributions like any other code
import — review before installing.

## Built-in checks (always on)

- `boundary:<rule>:<file>:<line>` — every boundary violation surfaces as a
  policy check.
- `forbidden:<hash>` — every documented forbidden action becomes an info
  check.
- `ownership:required-review` — emitted when a plan touches files with
  `requiredReview: true` ownership rules.
- `plan:unsigned` — emitted when `--plan <plan.json>` is provided and the
  plan lacks a signature.
- `pack:unverified:<name>` — emitted when a discovered pack has a non-OK
  signature status.

## Snapshot testing (R12)

```bash
# Capture a snapshot the first time, then compare on subsequent runs.
shrk policy test <id> --fixture <dir>                 # auto-uses snapshot.json if present
shrk policy test <id> --fixture <dir> --update-snapshot  # re-write the snapshot

# Standalone snapshot batch:
shrk policy snapshot <id> --input '{"planTargets":["src/x.ts"]}'
shrk policy snapshot --all --fixture <fixtures-root>
```

Snapshot files live as `<fixtureDir>/snapshot.json`:

```jsonc
{
  "schema": "sharkcraft.policy-snapshot/v1",
  "policyId": "my.guard",
  "inputHash": "ab12cd34…",
  "passed": false,
  "severityHighest": "warning",
  "message": "cannot touch .env",
  "evidence": ["[warning] my.guard"]
}
```

SharkCraft only writes snapshot files inside the supplied fixture
directory (or `.sharkcraft/policy-snapshots/` when no fixture is given).
There are no source writes.

## CI gate (R13)

```bash
shrk policy snapshot --all --fixture <dir> --gate     # non-zero on drift / missing
shrk policy snapshot --all --fixture <dir> --accept   # rewrite snapshots after review
shrk policy snapshot <id> --gate --json               # single-policy CI gate
```

Output buckets every result into **passed / drifted / missing /
updated / skipped**. The exit code is `0` only when no drift or
missing entries remain (or `--gate` was omitted). Use `--accept` after
human review to update snapshots — `--accept` writes only inside
fixture directories.

### GitHub Actions example

```yaml
- name: Policy snapshot gate
  run: bun run shrk policy snapshot --all --fixture sharkcraft/fixtures --gate --json
```

`shrk ci scaffold github-actions --with-policy` adds this step
automatically.

## Policy overrides (R18) + audit trail (R19/R20)

Local config may relax or disable individual checks:

```ts
// sharkcraft.config.ts
export default {
  // …
  policyOverrides: [
    { policyId: 'plan:unsigned', severity: 'info', reason: 'dev workspaces only' },
  ],
};
```

Apply the overrides at run-time:

```bash
shrk policy run --explain-overrides          # show what was promoted/demoted/disabled
shrk policy overrides                        # list configured overrides
shrk policy overrides audit                  # read the append-only audit trail
```

The audit log lives at `.sharkcraft/policy-override-audit.log` (JSON
lines). It is **never written automatically**. To record an entry, pass
`--record-override-audit` to `shrk policy run`; if any override was
applied during that run, one entry is appended per applied override
(`policyId, originalSeverity, effectiveSeverity, disabled, reason,
sourceConfig, command`).

```bash
shrk policy run --record-override-audit         # append entries when overrides apply
shrk policy overrides audit --format markdown   # render the trail as markdown
shrk policy overrides audit --json              # JSON for CI
```

`get_policy_override_audit` exposes the trail to MCP read-only.

## MCP

`get_policy_report` exposes the full report read-only.
