import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  buildApproval,
  checkAgentContract,
  computeContractHash,
  inspectSharkcraft,
  parseRelativeExpiry,
  renderContractCheckMarkdown,
  renderContractCheckText,
  type IAgentContract,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson } from '../output/format-output.ts';

function readContract(file: string): IAgentContract {
  return JSON.parse(readFileSync(file, 'utf8')) as IAgentContract;
}

function resolveAgainstCwd(cwd: string, file: string): string {
  return nodePath.isAbsolute(file) ? file : nodePath.resolve(cwd, file);
}

export const contractCheckCommand: ICommandHandler = {
  name: 'check',
  description:
    'Validate an agent contract — required gates, plan readiness (if --plan supplied), forbidden files, public-API touch, risk + memory approval. Read-only.',
  usage:
    'shrk contract check <contract.json> [--plan <plan.json>] [--approval <approval.json>] [--format text|markdown|json] [--output <file>]',
  async run(args: ParsedArgs): Promise<number> {
    const contractFile = args.positional[0];
    if (!contractFile) {
      process.stderr.write('Usage: shrk contract check <contract.json>\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const absContract = resolveAgainstCwd(cwd, contractFile);
    if (!existsSync(absContract)) {
      process.stderr.write(`Contract not found: ${absContract}\n`);
      return 1;
    }
    let contract: IAgentContract;
    try {
      contract = readContract(absContract);
    } catch (e) {
      process.stderr.write(`Failed to parse contract: ${(e as Error).message}\n`);
      return 1;
    }
    const planFlag = flagString(args, 'plan');
    const approvalFlag = flagString(args, 'approval');
    const planPath = planFlag ? resolveAgainstCwd(cwd, planFlag) : undefined;
    const approvalPath = approvalFlag ? resolveAgainstCwd(cwd, approvalFlag) : undefined;

    const report = await checkAgentContract(inspection, contract, {
      ...(planPath ? { planPath } : {}),
      ...(approvalPath ? { approvalPath } : {}),
    });

    const format = (flagString(args, 'format') ?? 'text').toLowerCase();
    let body: string;
    if (format === 'json' || flagBool(args, 'json')) body = asJson(report) + '\n';
    else if (format === 'markdown' || format === 'md') body = renderContractCheckMarkdown(report);
    else body = renderContractCheckText(report);

    const output = flagString(args, 'output');
    if (output) {
      const abs = resolveAgainstCwd(cwd, output);
      mkdirSync(nodePath.dirname(abs), { recursive: true });
      writeFileSync(abs, body, 'utf8');
      process.stdout.write(`Wrote ${abs}\n`);
    } else {
      process.stdout.write(body);
    }
    return report.pass ? 0 : 1;
  },
};

export const contractApproveCommand: ICommandHandler = {
  name: 'approve',
  description:
    'Sign an approval for a contract. Approval writes only to the supplied --output path (no implicit locations). Read-only otherwise.',
  usage:
    'shrk contract approve <contract.json> --by <name> --reason "<text>" [--expires-in 2d|1h|30m|1w] [--expires-at <ISO>] [--gates a,b,c] [--output <approval.json>] [--secret-env <NAME>]',
  async run(args: ParsedArgs): Promise<number> {
    const contractFile = args.positional[0];
    if (!contractFile) {
      process.stderr.write('Usage: shrk contract approve <contract.json> --by <name> --reason "<text>"\n');
      return 2;
    }
    const by = flagString(args, 'by');
    const reason = flagString(args, 'reason');
    if (!by || !reason) {
      process.stderr.write('Both --by <name> and --reason "<text>" are required.\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const absContract = resolveAgainstCwd(cwd, contractFile);
    if (!existsSync(absContract)) {
      process.stderr.write(`Contract not found: ${absContract}\n`);
      return 1;
    }
    let contract: IAgentContract;
    try {
      contract = readContract(absContract);
    } catch (e) {
      process.stderr.write(`Failed to parse contract: ${(e as Error).message}\n`);
      return 1;
    }
    const gates = flagString(args, 'gates');
    const expiresIn = flagString(args, 'expires-in');
    const expiresAt = flagString(args, 'expires-at') ?? flagString(args, 'expires');
    let resolvedExpiresAt: string | undefined;
    if (expiresIn) {
      const parsed = parseRelativeExpiry(expiresIn);
      if (!parsed) {
        process.stderr.write(`Invalid --expires-in value: ${expiresIn} (expected e.g. 30m, 2h, 7d, 1w)\n`);
        return 2;
      }
      resolvedExpiresAt = parsed;
    } else if (expiresAt) {
      const t = Date.parse(expiresAt);
      if (Number.isNaN(t)) {
        process.stderr.write(`Invalid --expires-at value: ${expiresAt} (expected ISO 8601 timestamp)\n`);
        return 2;
      }
      resolvedExpiresAt = new Date(t).toISOString();
    }
    const secretEnv = flagString(args, 'secret-env');
    const hash = computeContractHash(contract);
    const approval = buildApproval({
      contractHash: hash,
      approvedBy: by,
      reason,
      ...(gates ? { approvedGates: gates.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
      ...(resolvedExpiresAt ? { expiresAt: resolvedExpiresAt } : {}),
      ...(secretEnv ? { secretEnv } : {}),
    });
    const output = flagString(args, 'output');
    if (!output) {
      // No implicit write location — print and let the human redirect.
      process.stdout.write(JSON.stringify(approval, null, 2) + '\n');
      process.stdout.write(
        `\n(no --output supplied; redirect or re-run with --output <file> to persist the approval)\n`,
      );
      return 0;
    }
    const abs = resolveAgainstCwd(cwd, output);
    mkdirSync(nodePath.dirname(abs), { recursive: true });
    writeFileSync(abs, JSON.stringify(approval, null, 2) + '\n', 'utf8');
    process.stdout.write(`Wrote ${abs}\n`);
    if (approval.signature) process.stdout.write(`  signed via ${secretEnv ?? 'SHARKCRAFT_CONTRACT_SECRET'}\n`);
    else process.stdout.write(`  unsigned (no contract secret env set)\n`);
    return 0;
  },
};

export const contractStatusCommand: ICommandHandler = {
  name: 'status',
  description:
    'Show the status of a contract: hash, role, mode, and (optionally) approval verification. Read-only.',
  usage: 'shrk contract status <contract.json> [--approval <approval.json>] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const contractFile = args.positional[0];
    if (!contractFile) {
      // `contract status` inspects a SAVED contract file — it is not a zero-arg
      // project-health command. Point at the canonical task form so the verb
      // doesn't read as a broken status command.
      process.stderr.write('Usage: shrk contract status <contract.json>   (inspect a saved contract file)\n');
      process.stderr.write('To build/inspect a contract for a task, run:  shrk contract "<task>"\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const absContract = resolveAgainstCwd(cwd, contractFile);
    if (!existsSync(absContract)) {
      process.stderr.write(`Contract not found: ${absContract}\n`);
      return 1;
    }
    let contract: IAgentContract;
    try {
      contract = readContract(absContract);
    } catch (e) {
      process.stderr.write(`Failed to parse contract: ${(e as Error).message}\n`);
      return 1;
    }
    const approvalFlag = flagString(args, 'approval');
    const approvalPath = approvalFlag ? resolveAgainstCwd(cwd, approvalFlag) : undefined;
    const report = await checkAgentContract(inspection, contract, {
      ...(approvalPath ? { approvalPath } : {}),
    });
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson({
        contractHash: report.contractHash,
        task: report.task,
        role: report.role,
        mode: report.mode,
        approvalStatus: report.approvalStatus,
        approvalMessage: report.approvalMessage,
        approvalExpiry: report.approvalExpiry,
        pass: report.pass,
        blockingGates: report.blockingGates,
        warnGates: report.warnGates,
      }) + '\n');
      return 0;
    }
    process.stdout.write(`Contract status\n`);
    process.stdout.write(`  hash         ${report.contractHash}\n`);
    process.stdout.write(`  task         ${report.task || '(empty)'}\n`);
    process.stdout.write(`  role/mode    ${report.role} / ${report.mode}\n`);
    process.stdout.write(`  approval     ${report.approvalStatus}${report.approvalMessage ? ' — ' + report.approvalMessage : ''}\n`);
    if (report.approvalExpiry) {
      const e = report.approvalExpiry;
      const detail = e.expiresAt ? ` — ${e.expiresAt}` : '';
      process.stdout.write(`  expiry       ${e.status}${detail}\n`);
      if (e.noExpiryWarning) process.stdout.write(`  warning      ${e.noExpiryWarning}\n`);
    }
    process.stdout.write(`  pass         ${report.pass ? 'yes' : 'no'}\n`);
    if (report.blockingGates.length) process.stdout.write(`  blocking     ${report.blockingGates.join(', ')}\n`);
    if (report.warnGates.length) process.stdout.write(`  warnings     ${report.warnGates.join(', ')}\n`);
    return report.pass ? 0 : 1;
  },
};

