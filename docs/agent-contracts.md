# Agent contracts

`shrk contract "<task>"` builds a deterministic, role-aware safety contract
that an AI agent — or a human — should follow when working on the task.

## Why

R20 already gave us `shrk risk` (a number) and R18 gave us a per-role manual
(the standalone `view` verb was retired into `shrk contract --role <role>`).
R23 ties those into a single per-task contract that an
agent can read once and then drive the rest of its workflow from.

## Usage

```
shrk contract "<task>" \
  [--role developer|reviewer|architect|release-manager|security|ai-agent] \
  [--mode conservative|balanced|aggressive] \
  [--files a,b,c] [--since <ref>] [--staged] \
  [--format text|markdown|html|json] [--output <file>] [--save]
```

- Default is read-only. `--save` writes a copy of the contract under
  `.sharkcraft/contracts/<timestamp>-<slug>.{txt|md|html}` (and a `.json`
  alongside). Never anywhere else.
- `--output <file>` redirects the rendered body to a specific path.

## Output schema

`sharkcraft.agent-contract/v1` — see `packages/inspector/src/agent-contract.ts`.

Selected fields:

| Field | What it means |
| --- | --- |
| `allowedFiles` / `forbiddenFiles` | Files the agent is and isn't allowed to touch. |
| `allowedCommands` / `forbiddenCommands` | CLI / MCP commands the agent may and may not call. |
| `requiredValidations` | `bun test`, `shrk doctor`, etc. — must pass. |
| `requiredReviews` | Human/API reviews needed. |
| `requiredPlanReviews` | `shrk plan review` + `shrk plan simulate` if applicable. |
| `humanApprovalGates` | Where a human must explicitly approve. |
| `rollbackPlan` | Step-by-step rollback. |
| `definitionOfDone` | What must be true before the task closes. |
| `publicApiRisks` | Public API surfaces touched. |
| `safetyNotes` | Reminders (MCP read-only, CLI is the only write path, …). |

## Rules (deterministic)

- `risk` high/critical or `intent.requiredHumanReview` → human approval required.
- Public-API touch → API review.
- Saved-plan / update-operation language in the task → `shrk plan review` +
  `shrk plan simulate` required.
- Release / migration intent → publish/tag forbidden without explicit
  human approval; `bun run release:preflight` + `shrk release readiness
  --strict` required.
- `role=ai-agent` → MCP writes forbidden (there are none), auto-apply
  forbidden, `shrk brief` / `shrk orchestrate` required first.

## Safety

- Read-only by default.
- `--save` only writes under `.sharkcraft/contracts/`.
- No model calls. No telemetry. No network.
- MCP: `create_agent_contract` is read-only.

## Contract gates (R24)

`shrk contract` now ships an opt-in gate surface that turns the advisory
contract into a pass / fail signal:

```
shrk contract check <contract.json> [--plan <plan.json>] [--approval <approval.json>]
shrk contract approve <contract.json> --by <name> --reason "<text>" \
  [--gates a,b,c] [--expires <ISO>] [--output <approval.json>] [--secret-env <NAME>]
shrk contract status <contract.json> [--approval <approval.json>]
```

Gates checked:

| Gate | Source |
| --- | --- |
| `human-approval` | `contract.humanApprovalGates` |
| `required-plan-review` | `contract.requiredPlanReviews` + plan simulation readiness |
| `forbidden-files` | `contract.forbiddenFiles` vs plan simulation files |
| `required-validations` | `contract.requiredValidations` listed |
| `public-api-review` | `publicApiRisks` OR plan simulation `publicApiTouched` |
| `risk-approval` | high/critical task risk |
| `memory-elevated-approval` | memory adjustment ≥ 4 |

Approval files are HMAC-signed when `SHARKCRAFT_CONTRACT_SECRET` is set.
Schema: `sharkcraft.agent-contract-approval/v1`.

## Apply exit-code policy (R25)

`shrk apply --contract --json` now emits a `gateResult` block carrying
`exitCategory`:

| `exitCategory` | Meaning |
| --- | --- |
| `ok` | Apply succeeded. |
| `blocked-contract-gate` | One or more contract gates failed. `contractGateFailures[]` lists the failing gate ids + status. |
| `blocked-signature` | `--require-signature` was set and the plan failed to verify. |
| `blocked-conflict` | The live plan has file conflicts. |
| `blocked-divergence` | The live plan diverged and `--allow-divergent` was not set. |
| `invalid-input` | Plan parse / contract parse failed. |

Exit code is nonzero when blocked (same as R24). CI can branch on
`gateResult.exitCategory` for a stable signal. Schema:
`sharkcraft.apply-gate/v1`.

## Apply contract gate (R24, opt-in)

```
shrk apply <plan.json> --contract <contract.json> --approval <approval.json>
```

When `--contract` is supplied, apply runs `contract check` first and
refuses to write if any gate is blocking. Without `--contract`, apply
behaviour is unchanged.

## Contract precision (R25)

R25 introduces **structured file rules** to replace the substring matcher used by R24's `forbidden-files` gate.

```ts
interface IContractFileRule {
  pattern: string;
  kind: 'glob' | 'path-prefix' | 'exact' | 'contains';
  reason?: string;
  severity?: 'error' | 'warning';
}
```

`IAgentContract` now carries optional `allowedFilesDetailed?[]` and
`forbiddenFilesDetailed?[]`. The R24-era `forbiddenFiles: string[]` is
still honoured (treated as `kind: 'contains'`). Glob support covers `*`,
`**`, and `?` deterministically — no external dependency.

## Approval expiry (R25)

```bash
shrk contract approve <c> --by you --reason "fix" --expires-in 2d --output approval.json
shrk contract approve <c> --by you --reason "fix" --expires-at 2026-05-20T10:00:00Z
```

`shrk contract check` / `shrk contract status` now surface
`approvalExpiry`:

| Status | Meaning |
| --- | --- |
| `valid` | Approval has an expiry and >4h remain. |
| `expires-soon` | <4h remain. |
| `expired` | Expiry passed (approval is rejected by the gate). |
| `no-expiry` | Approval has no `expiresAt`. For high/critical risk, a `noExpiryWarning` is emitted. |
| `absent` | No approval supplied. |

The HMAC payload (`SHARKCRAFT_CONTRACT_SECRET`) already covers
`expiresAt`; no schema migration needed.

## Contract templates (R25)

```bash
shrk contract template list
shrk contract template get <id>
shrk contract template render <id> --task "<task>" [--role ai-agent]
shrk contract template recommend "<task>" [--role <role>] [--intent <kind>]
```

Built-in templates: `ai-agent-safe-change`, `public-api-change`,
`release-task`, `migration-task`, `security-sensitive-change`,
`polyglot-service-change`. Schema: `sharkcraft.agent-contract-template/v1`.
MCP: `list_contract_templates`, `get_contract_template` (read-only).

## MCP

- `create_agent_contract` — read-only.
- `get_contract_status` — read-only.
- `create_contract_approval_preview` — read-only **preview only**; MCP
  cannot persist approvals. The human runs `shrk contract approve …
  --output …` to actually write the approval.
- `list_contract_templates` / `get_contract_template` (R25) — read-only.
