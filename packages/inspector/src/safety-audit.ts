import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export interface ISafetyAuditCommand {
  command: string;
  description: string;
  category: string;
  safetyLevel: string;
}

export interface ISafetyAuditMcpTool {
  name: string;
  description: string;
  /** Whether the tool could ever cause a write. SharkCraft's contract is `false`. */
  canWrite: boolean;
}

export interface ISafetyAuditVerification {
  id: string;
  command: string;
  trusted: boolean;
  source: 'local' | 'pack';
  packPackageName?: string;
}

export interface ISafetyAuditPack {
  packageName: string;
  packageVersion: string;
  valid: boolean;
  signatureStatus: string;
}

export interface ISafetyAuditReport {
  commands: {
    writesSource: readonly ISafetyAuditCommand[];
    writesDrafts: readonly ISafetyAuditCommand[];
    writesSession: readonly ISafetyAuditCommand[];
    runsShell: readonly ISafetyAuditCommand[];
    requiresReview: readonly ISafetyAuditCommand[];
    readOnly: readonly ISafetyAuditCommand[];
  };
  mcp: {
    tools: readonly ISafetyAuditMcpTool[];
    /** True if any MCP tool has canWrite=true. SharkCraft never flips this. */
    anyWritable: boolean;
  };
  verifications: {
    trusted: readonly ISafetyAuditVerification[];
    pack: readonly ISafetyAuditVerification[];
    untrusted: readonly ISafetyAuditVerification[];
  };
  packs: {
    discovered: number;
    signedAndVerified: number;
    signedNotVerified: number;
    unsigned: number;
    invalid: number;
    items: readonly ISafetyAuditPack[];
  };
  planSigning: {
    secretConfigured: boolean;
    secretEnv: string;
  };
  recommendations: readonly string[];
}

export interface IBuildSafetyAuditInput {
  inspection: ISharkcraftInspection;
  /** CLI-side command catalog. Pass the same array that backs `shrk commands`. */
  catalog: readonly {
    command: string;
    description: string;
    category: string;
    safetyLevel: string;
    writesFiles: boolean;
    writesSource: boolean;
    runsShell: boolean;
    requiresReview: boolean;
    mcpAvailable: boolean;
  }[];
  /** MCP tool definitions (name + description). */
  mcpTools: readonly { name: string; description: string }[];
  /** Plan signing secret env var name. */
  planSecretEnv?: string;
  /** Pre-resolved presence of the plan secret in the environment. */
  planSecretConfigured?: boolean;
}

/**
 * Build a deterministic safety audit report from an inspection + the CLI
 * command catalog + the MCP tool list. Pure — no IO. The catalog/tool
 * inputs are passed in to avoid creating a CLI → MCP-server import
 * dependency.
 */
export function buildSafetyAudit(input: IBuildSafetyAuditInput): ISafetyAuditReport {
  const writesSource: ISafetyAuditCommand[] = [];
  const writesDrafts: ISafetyAuditCommand[] = [];
  const writesSession: ISafetyAuditCommand[] = [];
  const runsShell: ISafetyAuditCommand[] = [];
  const requiresReview: ISafetyAuditCommand[] = [];
  const readOnly: ISafetyAuditCommand[] = [];

  for (const e of input.catalog) {
    const summary: ISafetyAuditCommand = {
      command: e.command,
      description: e.description,
      category: e.category,
      safetyLevel: e.safetyLevel,
    };
    switch (e.safetyLevel) {
      case 'writes-source':
        writesSource.push(summary);
        break;
      case 'writes-drafts':
        writesDrafts.push(summary);
        break;
      case 'writes-session':
        writesSession.push(summary);
        break;
      case 'runs-shell':
        runsShell.push(summary);
        break;
      case 'read-only':
        readOnly.push(summary);
        break;
      default:
        break;
    }
    if (e.requiresReview) requiresReview.push(summary);
  }

  const mcpTools: ISafetyAuditMcpTool[] = input.mcpTools.map((t) => ({
    name: t.name,
    description: t.description,
    canWrite: false,
  }));
  const anyWritable = mcpTools.some((t) => t.canWrite);

  // Verifications: split into trusted local + pack-contributed + untrusted.
  const trusted: ISafetyAuditVerification[] = [];
  const pack: ISafetyAuditVerification[] = [];
  const untrusted: ISafetyAuditVerification[] = [];
  const configCmds = input.inspection.config?.verificationCommands ?? [];
  for (const v of configCmds) {
    const item: ISafetyAuditVerification = {
      id: v.id,
      command: v.command,
      trusted: v.trusted === true,
      source: 'local',
    };
    if (item.trusted) trusted.push(item);
    else untrusted.push(item);
  }
  for (const p of input.inspection.packs.validPacks) {
    const packCmds = (p.manifest?.contributions as { verificationCommands?: { id: string; command: string }[] })
      ?.verificationCommands;
    if (!Array.isArray(packCmds)) continue;
    for (const v of packCmds) {
      pack.push({
        id: v.id,
        command: v.command,
        trusted: false,
        source: 'pack',
        packPackageName: p.packageName,
      });
    }
  }

  // Pack signature breakdown.
  let signedAndVerified = 0;
  let signedNotVerified = 0;
  let unsigned = 0;
  let invalid = 0;
  const items: ISafetyAuditPack[] = [];
  for (const p of input.inspection.packs.discoveredPacks) {
    const sig = p.signatureStatus ?? 'unsigned';
    items.push({
      packageName: p.packageName,
      packageVersion: p.packageVersion,
      valid: p.valid,
      signatureStatus: sig,
    });
    if (!p.valid) invalid += 1;
    else if (sig === 'verified') signedAndVerified += 1;
    else if (sig === 'not-checked') signedNotVerified += 1;
    else if (sig === 'invalid-signature') invalid += 1;
    else unsigned += 1;
  }

  const planSecretEnv = input.planSecretEnv ?? 'SHARKCRAFT_PLAN_SECRET';
  const planSecretConfigured =
    input.planSecretConfigured ?? (typeof process !== 'undefined' && process.env[planSecretEnv] !== undefined);

  const recommendations: string[] = [];
  if (anyWritable) {
    recommendations.push('CRITICAL: at least one MCP tool reports canWrite=true. MCP must remain read-only.');
  }
  if (signedNotVerified > 0) {
    recommendations.push(
      `${signedNotVerified} pack(s) are signed but not verified. Run \`shrk packs verify\` with the appropriate secret.`,
    );
  }
  if (unsigned > 0) {
    recommendations.push(
      `${unsigned} pack(s) are unsigned. Sign packs with \`shrk pack sign\` before adopting in production.`,
    );
  }
  if (untrusted.length > 0) {
    recommendations.push(
      `${untrusted.length} local verification command(s) are not marked trusted. Review before relying on them in \`shrk apply --validate\`.`,
    );
  }
  if (pack.length > 0) {
    recommendations.push(
      `${pack.length} pack-contributed verification command(s) are NOT auto-runnable — they require explicit \`--allow-pack-commands\`.`,
    );
  }
  if (!planSecretConfigured) {
    recommendations.push(
      `Plan signing secret \`${planSecretEnv}\` is not set in the current environment — \`shrk apply --verify-signature\` will treat plans as unsigned unless --require-signature is used.`,
    );
  }
  if (writesSource.length > 0) {
    recommendations.push(
      `${writesSource.length} CLI command(s) write source. Treat them as the explicit human-approval step.`,
    );
  }

  return {
    commands: { writesSource, writesDrafts, writesSession, runsShell, requiresReview, readOnly },
    mcp: { tools: mcpTools, anyWritable },
    verifications: { trusted, pack, untrusted },
    packs: { discovered: items.length, signedAndVerified, signedNotVerified, unsigned, invalid, items },
    planSigning: { secretConfigured: planSecretConfigured, secretEnv: planSecretEnv },
    recommendations,
  };
}
