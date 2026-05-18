import { mkdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  getContractTemplate,
  listContractTemplates,
  recommendContractTemplate,
  renderContractTemplateMarkdown,
  renderContractTemplateText,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson } from '../output/format-output.ts';

export const contractTemplateListCommand: ICommandHandler = {
  name: 'list',
  description: 'List built-in contract templates. Read-only.',
  usage: 'shrk contract template list [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const list = listContractTemplates();
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(list) + '\n');
      return 0;
    }
    for (const t of list) {
      process.stdout.write(`${t.id.padEnd(32)} ${t.title}\n`);
      process.stdout.write(`  role: ${t.role} / mode: ${t.mode}\n`);
      process.stdout.write(`  ${t.description}\n\n`);
    }
    return 0;
  },
};

export const contractTemplateGetCommand: ICommandHandler = {
  name: 'get',
  description: 'Show a single contract template by id. Read-only.',
  usage: 'shrk contract template get <id> [--format text|markdown|json] [--output <file>]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk contract template get <id>\n');
      return 2;
    }
    const tpl = getContractTemplate(id);
    if (!tpl) {
      process.stderr.write(`Unknown template id: ${id}\n`);
      return 1;
    }
    const format = (flagString(args, 'format') ?? 'text').toLowerCase();
    let body: string;
    if (format === 'json' || flagBool(args, 'json')) body = asJson(tpl) + '\n';
    else if (format === 'markdown' || format === 'md') body = renderContractTemplateMarkdown(tpl);
    else body = renderContractTemplateText(tpl);
    const cwd = resolveCwd(args);
    const out = flagString(args, 'output');
    if (out) {
      const abs = nodePath.isAbsolute(out) ? out : nodePath.resolve(cwd, out);
      mkdirSync(nodePath.dirname(abs), { recursive: true });
      writeFileSync(abs, body, 'utf8');
      process.stdout.write(`Wrote ${abs}\n`);
      return 0;
    }
    process.stdout.write(body);
    return 0;
  },
};

export const contractTemplateRenderCommand: ICommandHandler = {
  name: 'render',
  description:
    'Render a contract template against a specific task (does not save). Read-only.',
  usage:
    'shrk contract template render <id> --task "<task>" [--role ai-agent|developer|...] [--format text|markdown|json] [--output <file>]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk contract template render <id> --task "<task>"\n');
      return 2;
    }
    const task = flagString(args, 'task');
    if (!task) {
      process.stderr.write('--task "<task>" is required.\n');
      return 2;
    }
    const tpl = getContractTemplate(id);
    if (!tpl) {
      process.stderr.write(`Unknown template id: ${id}\n`);
      return 1;
    }
    const format = (flagString(args, 'format') ?? 'markdown').toLowerCase();
    let body: string;
    if (format === 'json' || flagBool(args, 'json')) body = asJson({ template: tpl, task }) + '\n';
    else if (format === 'text' || format === 'txt') body = renderContractTemplateText(tpl, task);
    else body = renderContractTemplateMarkdown(tpl, task);
    const cwd = resolveCwd(args);
    const out = flagString(args, 'output');
    if (out) {
      const abs = nodePath.isAbsolute(out) ? out : nodePath.resolve(cwd, out);
      mkdirSync(nodePath.dirname(abs), { recursive: true });
      writeFileSync(abs, body, 'utf8');
      process.stdout.write(`Wrote ${abs}\n`);
      return 0;
    }
    process.stdout.write(body);
    return 0;
  },
};

export const contractTemplateRecommendCommand: ICommandHandler = {
  name: 'recommend',
  description: 'Recommend contract templates for a task. Read-only.',
  usage: 'shrk contract template recommend "<task>" [--role <role>] [--intent <kind>] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const task = args.positional.join(' ').trim();
    if (!task) {
      process.stderr.write('Usage: shrk contract template recommend "<task>"\n');
      return 2;
    }
    const role = flagString(args, 'role');
    const intent = flagString(args, 'intent');
    const matches = recommendContractTemplate(task, role as never, intent);
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(matches) + '\n');
      return 0;
    }
    if (matches.length === 0) {
      process.stdout.write('No contract templates matched.\n');
      return 0;
    }
    for (const m of matches) {
      process.stdout.write(`${m.match.padEnd(8)} ${m.template.id}  — ${m.reason}\n`);
    }
    return 0;
  },
};

/** Dispatcher for `shrk contract template <list|get|render|recommend>`. */
export const contractTemplateCommand: ICommandHandler = {
  name: 'template',
  description: 'Reusable agent-contract templates (list / get / render / recommend). Read-only.',
  usage: 'shrk contract template <list|get|render|recommend> [...]',
  async run(args: ParsedArgs): Promise<number> {
    const sub = args.positional[0];
    if (!sub) {
      process.stderr.write('Usage: shrk contract template <list|get|render|recommend>\n');
      return 2;
    }
    const next = { ...args, positional: args.positional.slice(1) };
    if (sub === 'list') return (await contractTemplateListCommand.run(next)) as number;
    if (sub === 'get') return (await contractTemplateGetCommand.run(next)) as number;
    if (sub === 'render') return (await contractTemplateRenderCommand.run(next)) as number;
    if (sub === 'recommend') return (await contractTemplateRecommendCommand.run(next)) as number;
    process.stderr.write(`Unknown contract template subcommand: ${sub}\n`);
    return 2;
  },
};
