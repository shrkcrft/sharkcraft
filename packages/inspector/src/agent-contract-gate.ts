/**
 * Agent contract gates.
 *
 * The base agent contract is advisory. This module adds an opt-in
 * gate system that turns a contract into pass/fail signals — and,
 * optionally, a hard gate for `shrk apply --contract`.
 *
 * Read-only. No source writes from this module. Approval writing is a
 * CLI-only explicit action handled by the command layer.
 */
import { createHash, createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { IAgentContract } from './agent-contract.ts';
import { TaskRiskLevel } from './task-risk.ts';
import type { IPlanSimulationReport } from './plan-simulation.ts';
import { simulatePlan } from './plan-simulation.ts';
import {
  matchContractFileRule,
  rulesFromLegacyStrings,
  type IContractFileRule,
} from './contract-file-rule.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const AGENT_CONTRACT_APPROVAL_SCHEMA = 'sharkcraft.agent-contract-approval/v1';
export const AGENT_CONTRACT_GATE_SCHEMA = 'sharkcraft.agent-contract-gate/v1';

export interface IAgentContractApproval {
  schema: typeof AGENT_CONTRACT_APPROVAL_SCHEMA;
  /** Stable hash of the contract this approval is bound to. */
  contractHash: string;
  /** Short contract id (slug + timestamp) for human readability. */
  contractId?: string;
  approvedBy: string;
  reason: string;
  approvedAt: string;
  /** Specific gates the approver acknowledged. */
  approvedGates: readonly string[];
  /** ISO timestamp at which the approval expires; absent = no expiry. */
  expiresAt?: string;
  /** Optional HMAC signature when SHARKCRAFT_CONTRACT_SECRET is set. */
  signature?: {
    algo: 'sha256';
    hmac: string;
    signedAt: string;
  };
}

export enum ContractGateStatus {
  Pass = 'pass',
  RequiresApproval = 'requires-approval',
  Fail = 'fail',
  Warn = 'warn',
}

export interface IContractGateResult {
  id: string;
  description: string;
  status: ContractGateStatus;
  detail?: string;
}

export enum ContractApprovalExpiryStatus {
  Valid = 'valid',
  ExpiresSoon = 'expires-soon',
  Expired = 'expired',
  NoExpiry = 'no-expiry',
  Absent = 'absent',
}

export interface IContractApprovalExpiry {
  status: ContractApprovalExpiryStatus;
  /** Milliseconds until expiry — negative when already expired. Absent for `absent` / `no-expiry`. */
  expiresInMs?: number;
  /** ISO timestamp at which the approval expires. */
  expiresAt?: string;
  /** ISO timestamp at which the approval expired (only set when `status === Expired`). */
  expiredAt?: string;
  /** Warning when the approval has no expiry and the contract is high/critical risk. */
  noExpiryWarning?: string;
}

export interface IContractCheckReport {
  schema: typeof AGENT_CONTRACT_GATE_SCHEMA;
  generatedAt: string;
  contractHash: string;
  contractId?: string;
  task: string;
  role: string;
  mode: string;
  gates: readonly IContractGateResult[];
  approval?: IAgentContractApproval;
  approvalStatus: 'absent' | 'present' | 'expired' | 'mismatched' | 'unsigned' | 'verified' | 'invalid';
  approvalMessage?: string;
  /** Expiry detail (status + remaining time). */
  approvalExpiry?: IContractApprovalExpiry;
  pass: boolean;
  blockingGates: readonly string[];
  warnGates: readonly string[];
  planSimulation?: IPlanSimulationReport;
  notes: readonly string[];
}

export interface ICheckContractOptions {
  planPath?: string;
  approvalPath?: string;
  /** Override secret env name; default `SHARKCRAFT_CONTRACT_SECRET`. */
  secretEnv?: string;
}

const APPROVAL_SECRET_ENV_DEFAULT = 'SHARKCRAFT_CONTRACT_SECRET';

/**
 * Deterministic JSON: keys sorted at EVERY depth, keys/values JSON-quoted.
 * Critically NOT `JSON.stringify(obj, keysArray)` — an array replacer is a key
 * ALLOWLIST applied at every nesting level, which silently DROPS nested-object
 * keys (e.g. `forbiddenFilesDetailed` rule fields) from the hash input, letting
 * a contract be tampered in a nested field without changing its hash and
 * bypassing approval binding.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((v) => canonicalJson(v)).join(',') + ']';
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const v = (value as Record<string, unknown>)[k];
    if (v === undefined) continue;
    parts.push(JSON.stringify(k) + ':' + canonicalJson(v));
  }
  return '{' + parts.join(',') + '}';
}

function canonicalContractJson(contract: IAgentContract): string {
  // Deterministic JSON for hashing — exclude `generatedAt` so hashes stay
  // stable across re-builds of the same task.
  const { generatedAt: _drop, ...rest } = contract;
  void _drop;
  return canonicalJson(rest);
}

export function computeContractHash(contract: IAgentContract): string {
  const h = createHash('sha256');
  h.update(canonicalContractJson(contract));
  return h.digest('hex');
}

function canonicalApprovalJson(a: IAgentContractApproval): string {
  const { signature: _drop, ...rest } = a;
  void _drop;
  return canonicalJson(rest);
}

export function signApproval(a: IAgentContractApproval, secret: string): IAgentContractApproval {
  const hmac = createHmac('sha256', secret);
  hmac.update(canonicalApprovalJson(a));
  return {
    ...a,
    signature: { algo: 'sha256', hmac: hmac.digest('hex'), signedAt: new Date().toISOString() },
  };
}

export function verifyApproval(
  a: IAgentContractApproval,
  secret: string,
): { ok: boolean; message: string } {
  if (!a.signature) return { ok: false, message: 'No signature.' };
  const hmac = createHmac('sha256', secret);
  hmac.update(canonicalApprovalJson(a));
  const expected = hmac.digest('hex');
  if (expected !== a.signature.hmac) return { ok: false, message: 'Signature mismatch.' };
  return { ok: true, message: 'verified' };
}

export interface IBuildApprovalInput {
  contractHash: string;
  contractId?: string;
  approvedBy: string;
  reason: string;
  approvedGates?: readonly string[];
  expiresAt?: string;
  /** When set, secret env (default `SHARKCRAFT_CONTRACT_SECRET`) signs the approval. */
  secretEnv?: string;
}

export function buildApproval(input: IBuildApprovalInput): IAgentContractApproval {
  const approval: IAgentContractApproval = {
    schema: AGENT_CONTRACT_APPROVAL_SCHEMA,
    contractHash: input.contractHash,
    approvedBy: input.approvedBy,
    reason: input.reason,
    approvedAt: new Date().toISOString(),
    approvedGates: input.approvedGates ? [...input.approvedGates] : [],
  };
  if (input.contractId !== undefined) approval.contractId = input.contractId;
  if (input.expiresAt !== undefined) approval.expiresAt = input.expiresAt;
  const secret = process.env[input.secretEnv ?? APPROVAL_SECRET_ENV_DEFAULT];
  if (secret) return signApproval(approval, secret);
  return approval;
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

function isExpired(a: IAgentContractApproval): boolean {
  if (!a.expiresAt) return false;
  const t = Date.parse(a.expiresAt);
  if (Number.isNaN(t)) return false;
  return t < Date.now();
}

const EXPIRES_SOON_WINDOW_MS = 4 * 60 * 60 * 1000; // 4 hours

/**
 * Parse a relative expiry string like `1h`, `2d`, `30m`, `45s`, `1w` and return
 * an absolute ISO timestamp from `from` (default now). Returns null when the
 * input cannot be parsed.
 */
export function parseRelativeExpiry(input: string, from: Date = new Date()): string | null {
  const m = /^([0-9]+)\s*(s|m|h|d|w)$/i.exec(input.trim());
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 10);
  const unit = m[2]!.toLowerCase();
  const ms =
    unit === 's' ? n * 1000 :
    unit === 'm' ? n * 60 * 1000 :
    unit === 'h' ? n * 60 * 60 * 1000 :
    unit === 'd' ? n * 24 * 60 * 60 * 1000 :
    unit === 'w' ? n * 7 * 24 * 60 * 60 * 1000 : 0;
  if (ms <= 0) return null;
  return new Date(from.getTime() + ms).toISOString();
}

function classifyExpiry(
  contract: IAgentContract,
  approval: IAgentContractApproval | undefined,
): IContractApprovalExpiry {
  if (!approval) return { status: ContractApprovalExpiryStatus.Absent };
  if (!approval.expiresAt) {
    const risk = contract.taskRisk.riskLevel;
    const out: IContractApprovalExpiry = { status: ContractApprovalExpiryStatus.NoExpiry };
    if (risk === TaskRiskLevel.High || risk === TaskRiskLevel.Critical) {
      out.noExpiryWarning =
        `Approval has no --expires-in / --expires-at and task risk is ${risk}; long-lived approvals should be avoided.`;
    }
    return out;
  }
  const t = Date.parse(approval.expiresAt);
  if (Number.isNaN(t)) {
    return { status: ContractApprovalExpiryStatus.NoExpiry, expiresAt: approval.expiresAt };
  }
  const remaining = t - Date.now();
  if (remaining < 0) {
    return {
      status: ContractApprovalExpiryStatus.Expired,
      expiresInMs: remaining,
      expiresAt: approval.expiresAt,
      expiredAt: approval.expiresAt,
    };
  }
  if (remaining < EXPIRES_SOON_WINDOW_MS) {
    return {
      status: ContractApprovalExpiryStatus.ExpiresSoon,
      expiresInMs: remaining,
      expiresAt: approval.expiresAt,
    };
  }
  return {
    status: ContractApprovalExpiryStatus.Valid,
    expiresInMs: remaining,
    expiresAt: approval.expiresAt,
  };
}

function classifyApproval(
  contract: IAgentContract,
  a: IAgentContractApproval | undefined,
  secret: string | undefined,
): { status: IContractCheckReport['approvalStatus']; message?: string } {
  if (!a) return { status: 'absent' };
  const hash = computeContractHash(contract);
  if (a.contractHash !== hash) {
    return {
      status: 'mismatched',
      message: `Approval is for a different contract (expected hash ${hash.slice(0, 12)}…, got ${a.contractHash.slice(0, 12)}…).`,
    };
  }
  if (isExpired(a)) return { status: 'expired', message: `Approval expired at ${a.expiresAt}.` };
  if (a.signature) {
    if (!secret) return { status: 'present', message: 'Signature present but no secret configured to verify.' };
    const v = verifyApproval(a, secret);
    return v.ok
      ? { status: 'verified', message: v.message }
      : { status: 'invalid', message: v.message };
  }
  return { status: 'unsigned' };
}

function gate(
  id: string,
  description: string,
  status: ContractGateStatus,
  detail?: string,
): IContractGateResult {
  return detail === undefined ? { id, description, status } : { id, description, status, detail };
}

export async function checkAgentContract(
  inspection: ISharkcraftInspection,
  contract: IAgentContract,
  options: ICheckContractOptions = {},
): Promise<IContractCheckReport> {
  const notes: string[] = [];
  let planSimulation: IPlanSimulationReport | undefined;

  // Resolve approval if provided.
  let approval: IAgentContractApproval | undefined;
  if (options.approvalPath) {
    if (!existsSync(options.approvalPath)) {
      notes.push(`Approval file not found: ${options.approvalPath}`);
    } else {
      try {
        approval = readJson<IAgentContractApproval>(options.approvalPath);
      } catch (e) {
        notes.push(`Failed to parse approval: ${(e as Error).message}`);
      }
    }
  }
  const secret = process.env[options.secretEnv ?? APPROVAL_SECRET_ENV_DEFAULT];
  const approvalClassification = classifyApproval(contract, approval, secret);
  const approvalAccepted =
    approval !== undefined &&
    (approvalClassification.status === 'unsigned' ||
      approvalClassification.status === 'verified' ||
      approvalClassification.status === 'present');

  // Run plan simulation if a plan path was supplied.
  if (options.planPath) {
    try {
      planSimulation = await simulatePlan(inspection, options.planPath, {
        includeBoundaries: true,
        includeImpact: true,
        includeOwnership: true,
      });
    } catch (e) {
      notes.push(`Plan simulation failed: ${(e as Error).message}`);
    }
  } else if (contract.requiredPlanReviews.length > 0) {
    notes.push(
      'Contract requires plan review(s) but no --plan was supplied; gate `required-plan-review` cannot validate.',
    );
  }

  const gates: IContractGateResult[] = [];

  // Gate 1: human approval gates listed in the contract.
  if (contract.humanApprovalGates.length === 0) {
    gates.push(
      gate('human-approval', 'Human approval gate(s).', ContractGateStatus.Pass, 'No human approval required by this contract.'),
    );
  } else if (approvalAccepted) {
    gates.push(
      gate(
        'human-approval',
        'Human approval gate(s).',
        ContractGateStatus.Pass,
        `Approved by ${approval!.approvedBy}.`,
      ),
    );
  } else {
    gates.push(
      gate(
        'human-approval',
        'Human approval gate(s).',
        ContractGateStatus.RequiresApproval,
        contract.humanApprovalGates.join(' / '),
      ),
    );
  }

  // Gate 2: required plan reviews — must have plan supplied + simulation ready.
  if (contract.requiredPlanReviews.length > 0) {
    if (!planSimulation) {
      gates.push(
        gate(
          'required-plan-review',
          'Required plan review.',
          ContractGateStatus.Fail,
          'No --plan supplied or plan simulation failed.',
        ),
      );
    } else if (planSimulation.applyReadiness === 'blocked-conflicts' ||
      planSimulation.applyReadiness === 'blocked-boundary' ||
      planSimulation.applyReadiness === 'blocked-policy' ||
      planSimulation.applyReadiness === 'blocked-signature' ||
      planSimulation.applyReadiness === 'blocked-missing-review'
    ) {
      gates.push(
        gate(
          'required-plan-review',
          'Required plan review.',
          ContractGateStatus.Fail,
          `Plan simulation: ${planSimulation.applyReadiness}.`,
        ),
      );
    } else {
      gates.push(
        gate(
          'required-plan-review',
          'Required plan review.',
          planSimulation.applyReadiness === 'ready-with-review'
            ? ContractGateStatus.Warn
            : ContractGateStatus.Pass,
          `Plan simulation: ${planSimulation.applyReadiness}.`,
        ),
      );
    }
  } else {
    gates.push(
      gate('required-plan-review', 'Required plan review.', ContractGateStatus.Pass, 'Not required.'),
    );
  }

  // Gate 3: forbidden files not touched.
  // Prefer detailed rules. Fall back to legacy string[] (contains-match).
  const detailedRules: readonly IContractFileRule[] = contract.forbiddenFilesDetailed && contract.forbiddenFilesDetailed.length > 0
    ? contract.forbiddenFilesDetailed
    : rulesFromLegacyStrings(contract.forbiddenFiles.map((s) => s.split(' ')[0]!.replace(/\*\*$/, '').replace(/\*$/, '')).filter((s) => s.length > 0));
  if (detailedRules.length > 0 && planSimulation) {
    const matches: { file: string; rule: IContractFileRule }[] = [];
    for (const f of planSimulation.files) {
      for (const r of detailedRules) {
        if (matchContractFileRule(r, f.relativePath)) matches.push({ file: f.relativePath, rule: r });
      }
    }
    if (matches.length > 0) {
      const summary = matches
        .slice(0, 8)
        .map((m) => `${m.file} (rule: ${m.rule.kind}=${m.rule.pattern})`)
        .join(', ');
      gates.push(
        gate(
          'forbidden-files',
          'Forbidden files not touched.',
          ContractGateStatus.Fail,
          `Plan touches: ${summary}${matches.length > 8 ? ` (+${matches.length - 8} more)` : ''}.`,
        ),
      );
    } else {
      gates.push(
        gate('forbidden-files', 'Forbidden files not touched.', ContractGateStatus.Pass),
      );
    }
  } else if (detailedRules.length > 0) {
    gates.push(
      gate(
        'forbidden-files',
        'Forbidden files not touched.',
        ContractGateStatus.Warn,
        'No --plan supplied; cannot verify forbidden-file gate.',
      ),
    );
  } else {
    gates.push(
      gate('forbidden-files', 'Forbidden files not touched.', ContractGateStatus.Pass, 'None forbidden.'),
    );
  }

  // Gate 4: required validations are listed (informational — runtime is the human's job).
  gates.push(
    gate(
      'required-validations',
      'Required validations listed.',
      contract.requiredValidations.length > 0 ? ContractGateStatus.Pass : ContractGateStatus.Warn,
      contract.requiredValidations.length > 0
        ? `${contract.requiredValidations.length} validation(s) listed.`
        : 'No validations listed.',
    ),
  );

  // Gate 5: public-API review required.
  const publicApi = contract.publicApiRisks.length > 0 || (planSimulation?.publicApiTouched ?? false);
  if (publicApi) {
    const reviewsHasApi = contract.requiredReviews.some((r) => r.toLowerCase().includes('api'));
    if (reviewsHasApi) {
      gates.push(
        gate('public-api-review', 'Public-API review required when API touched.', ContractGateStatus.Pass),
      );
    } else if (approvalAccepted) {
      gates.push(
        gate('public-api-review', 'Public-API review required.', ContractGateStatus.Pass, `Approved by ${approval!.approvedBy}.`),
      );
    } else {
      gates.push(
        gate(
          'public-api-review',
          'Public-API review required.',
          ContractGateStatus.RequiresApproval,
          'Contract does not list an explicit API review.',
        ),
      );
    }
  } else {
    gates.push(
      gate('public-api-review', 'Public-API review required when API touched.', ContractGateStatus.Pass, 'No public API touched.'),
    );
  }

  // Gate 6: risk requires approval.
  const highRisk = contract.taskRisk.riskLevel === TaskRiskLevel.High || contract.taskRisk.riskLevel === TaskRiskLevel.Critical;
  if (highRisk || contract.taskRisk.humanApprovalRequired) {
    if (approvalAccepted) {
      gates.push(
        gate('risk-approval', 'High-risk approval.', ContractGateStatus.Pass, `Approved by ${approval!.approvedBy}.`),
      );
    } else {
      gates.push(
        gate(
          'risk-approval',
          'High-risk approval.',
          ContractGateStatus.RequiresApproval,
          `Risk: ${contract.taskRisk.riskLevel} (score ${contract.taskRisk.score}).`,
        ),
      );
    }
  } else {
    gates.push(gate('risk-approval', 'High-risk approval.', ContractGateStatus.Pass, 'Not high-risk.'));
  }

  // Gate 7: memory adjustment elevates required approval if non-trivial.
  if (contract.taskRisk.memory && contract.taskRisk.memory.score >= 4) {
    if (approvalAccepted) {
      gates.push(
        gate('memory-elevated-approval', 'Memory-elevated approval.', ContractGateStatus.Pass, `Approved by ${approval!.approvedBy}.`),
      );
    } else {
      gates.push(
        gate(
          'memory-elevated-approval',
          'Memory-elevated approval.',
          ContractGateStatus.RequiresApproval,
          `Memory adjustment +${contract.taskRisk.memory.score} suggests review.`,
        ),
      );
    }
  } else if (contract.taskRisk.memory && contract.taskRisk.memory.missing) {
    gates.push(
      gate('memory-elevated-approval', 'Memory-elevated approval.', ContractGateStatus.Warn, 'Memory index missing.'),
    );
  } else {
    gates.push(gate('memory-elevated-approval', 'Memory-elevated approval.', ContractGateStatus.Pass));
  }

  const blockingGates = gates.filter((g) => g.status === ContractGateStatus.Fail || g.status === ContractGateStatus.RequiresApproval).map((g) => g.id);
  const warnGates = gates.filter((g) => g.status === ContractGateStatus.Warn).map((g) => g.id);
  const pass = blockingGates.length === 0;

  // Surface approval expiry detail + warn when a high/critical-risk
  // approval has no expiry.
  const approvalExpiry = classifyExpiry(contract, approval);
  if (approvalExpiry.noExpiryWarning) notes.push(approvalExpiry.noExpiryWarning);
  if (approvalExpiry.status === ContractApprovalExpiryStatus.ExpiresSoon) {
    notes.push(`Approval expires in ${Math.round((approvalExpiry.expiresInMs ?? 0) / 60000)} min — re-approve before then.`);
  }

  const result: IContractCheckReport = {
    schema: AGENT_CONTRACT_GATE_SCHEMA,
    generatedAt: new Date().toISOString(),
    contractHash: computeContractHash(contract),
    task: contract.task,
    role: contract.role,
    mode: contract.mode,
    gates,
    approvalStatus: approvalClassification.status,
    approvalExpiry,
    pass,
    blockingGates,
    warnGates,
    notes,
  };
  if (approval) result.approval = approval;
  if (approvalClassification.message) result.approvalMessage = approvalClassification.message;
  if (planSimulation) result.planSimulation = planSimulation;
  return result;
}

export function renderContractCheckText(r: IContractCheckReport): string {
  let out = `=== Contract check ===\n`;
  out += `  task             ${r.task || '(empty)'}\n`;
  out += `  role/mode        ${r.role} / ${r.mode}\n`;
  out += `  contract hash    ${r.contractHash.slice(0, 12)}…\n`;
  out += `  approval         ${r.approvalStatus}${r.approvalMessage ? ' — ' + r.approvalMessage : ''}\n`;
  out += `  overall          ${r.pass ? 'PASS' : 'BLOCK'}\n\n`;
  out += `Gates:\n`;
  for (const g of r.gates) {
    out += `  [${g.status.toUpperCase().padEnd(18)}] ${g.id.padEnd(28)} ${g.description}${g.detail ? '  — ' + g.detail : ''}\n`;
  }
  if (r.blockingGates.length > 0) {
    out += `\nBlocking: ${r.blockingGates.join(', ')}\n`;
  }
  if (r.warnGates.length > 0) out += `Warnings: ${r.warnGates.join(', ')}\n`;
  if (r.notes.length > 0) {
    out += `\nNotes:\n`;
    for (const n of r.notes) out += `  • ${n}\n`;
  }
  return out;
}

export function renderContractCheckMarkdown(r: IContractCheckReport): string {
  let out = `# Contract check\n\n`;
  out += `- **task**: ${r.task || '(empty)'}\n`;
  out += `- **role / mode**: ${r.role} / ${r.mode}\n`;
  out += `- **contract hash**: \`${r.contractHash.slice(0, 16)}…\`\n`;
  out += `- **approval**: ${r.approvalStatus}${r.approvalMessage ? ' — ' + r.approvalMessage : ''}\n`;
  out += `- **overall**: ${r.pass ? '✅ PASS' : '❌ BLOCK'}\n\n`;
  out += `## Gates\n\n`;
  out += `| Status | Gate | Description | Detail |\n| --- | --- | --- | --- |\n`;
  for (const g of r.gates) {
    out += `| ${g.status} | \`${g.id}\` | ${g.description} | ${g.detail ?? ''} |\n`;
  }
  if (r.blockingGates.length > 0) out += `\n**Blocking**: ${r.blockingGates.join(', ')}\n`;
  if (r.warnGates.length > 0) out += `**Warnings**: ${r.warnGates.join(', ')}\n`;
  if (r.notes.length > 0) {
    out += `\n## Notes\n`;
    for (const n of r.notes) out += `- ${n}\n`;
  }
  return out;
}
