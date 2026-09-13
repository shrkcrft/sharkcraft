import { mkdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  buildAgentContract,
  inspectSharkcraft,
  renderAgentContractHtml,
  renderAgentContractMarkdown,
  renderAgentContractText,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { PositionalMode } from '../dispatch/positional-mode.ts';
import { asJson } from '../output/format-output.ts';
import {
  contractApproveCommand,
  contractCheckCommand,
  contractStatusCommand,
} from './contract-gate.command.ts';
import { contractTemplateCommand } from './contract-templates.command.ts';

function parseFiles(args: ParsedArgs): string[] {
  const raw = flagString(args, 'files');
  if (!raw) return [];
  return raw
    .split(',')
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
}

function safeSlug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 64) || 'contract'
  );
}

export const contractCommand: ICommandHandler = {
  name: 'contract',
  // Free: `contract "<task>"` takes the task as free text.
  positionals: PositionalMode.Free,
  subverbs: [
    { name: 'check', description: 'Check a saved contract against the workspace.', usage: 'shrk contract check <contract.json>', positionals: PositionalMode.Path },
    {
      name: 'approve',
      description: 'Approve a saved contract.',
      usage: 'shrk contract approve <contract.json> --by <name> --reason "<why>"',
      positionals: PositionalMode.Path,
    },
    { name: 'status', description: 'Inspect a saved contract file.', usage: 'shrk contract status <contract.json>', positionals: PositionalMode.Path },
    {
      name: 'template',
      description: 'Contract templates: list / get / render / recommend.',
      usage: 'shrk contract template <list|get|render|recommend>',
      positionals: PositionalMode.None,
      subverbs: [
        { name: 'list', description: 'List the contract templates.', usage: 'shrk contract template list [--json]' },
        { name: 'get', description: 'Show one contract template.', usage: 'shrk contract template get <id>', positionals: PositionalMode.Free },
        {
          name: 'render',
          description: 'Render a contract template for a task.',
          usage: 'shrk contract template render <id> --task "<task>"',
          positionals: PositionalMode.Free,
        },
        {
          name: 'recommend',
          description: 'Recommend a contract template for a task.',
          usage: 'shrk contract template recommend "<task>"',
          positionals: PositionalMode.Free,
        },
      ],
    },
  ],
  description:
    'Build a deterministic agent contract for a task (intent + risk + impact + ownership + boundaries + policies + playbooks). Read-only unless --save (writes only to .sharkcraft/contracts/).',
  usage:
    'shrk contract "<task>" [--role developer|reviewer|architect|release-manager|security|ai-agent] [--mode conservative|balanced|aggressive] [--files a,b,c] [--since <ref>] [--staged] [--format text|markdown|html|json] [--output <file>] [--save]',
  async run(args: ParsedArgs): Promise<number> {
    // Dispatch to subcommands (check / approve / status / template).
    const first = args.positional[0];
    if (first === 'check' || first === 'approve' || first === 'status') {
      const sub =
        first === 'check'
          ? contractCheckCommand
          : first === 'approve'
            ? contractApproveCommand
            : contractStatusCommand;
      return (await sub.run({ ...args, positional: args.positional.slice(1) })) as number;
    }
    if (first === 'template') {
      return (await contractTemplateCommand.run({ ...args, positional: args.positional.slice(1) })) as number;
    }
    const task = args.positional.join(' ').trim();
    if (!task) {
      process.stderr.write('Usage: shrk contract "<task>"  |  shrk contract {check|approve|status} <contract.json>\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const role = flagString(args, 'role');
    const mode = flagString(args, 'mode');
    const files = parseFiles(args);
    const since = flagString(args, 'since');
    const staged = flagBool(args, 'staged');
    const contract = await buildAgentContract(task, inspection, {
      ...(role ? { role } : {}),
      ...(mode ? { mode } : {}),
      ...(files.length > 0 ? { files } : {}),
      ...(since ? { since } : {}),
      ...(staged ? { staged: true } : {}),
    });

    const format = (flagString(args, 'format') ?? 'text').toLowerCase();
    let body: string;
    let extension: string;
    if (format === 'json' || flagBool(args, 'json')) {
      body = asJson(contract) + '\n';
      extension = 'json';
    } else if (format === 'markdown' || format === 'md') {
      body = renderAgentContractMarkdown(contract);
      extension = 'md';
    } else if (format === 'html') {
      body = renderAgentContractHtml(contract);
      extension = 'html';
    } else {
      body = renderAgentContractText(contract);
      extension = 'txt';
    }

    const output = flagString(args, 'output');
    if (output) {
      const abs = nodePath.isAbsolute(output) ? output : nodePath.resolve(cwd, output);
      mkdirSync(nodePath.dirname(abs), { recursive: true });
      writeFileSync(abs, body, 'utf8');
      process.stdout.write(`Wrote ${abs}\n`);
      return 0;
    }

    if (flagBool(args, 'save')) {
      // Writes only under .sharkcraft/contracts/ — never anywhere else.
      const dir = nodePath.join(cwd, '.sharkcraft', 'contracts');
      mkdirSync(dir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const file = nodePath.join(dir, `${ts}-${safeSlug(task)}.${extension}`);
      writeFileSync(file, body, 'utf8');
      // Also save the canonical JSON alongside so downstream tools can read it.
      if (extension !== 'json') {
        writeFileSync(file.replace(/\.[^.]+$/, '.json'), asJson(contract) + '\n', 'utf8');
      }
      process.stdout.write(`Wrote ${file}\n`);
      return 0;
    }

    process.stdout.write(body);
    return 0;
  },
};
