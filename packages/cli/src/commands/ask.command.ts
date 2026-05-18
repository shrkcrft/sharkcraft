import { inspectSharkcraft, buildProjectOverview, renderOverviewText } from '@shrkcrft/inspector';
import { buildContext } from '@shrkcrft/context';
import { ClaudeProvider, AiMessageRole, buildPromptMessages } from '@shrkcrft/ai';
import {
  flagBool,
  flagNumber,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { header } from '../output/format-output.ts';
import { printError } from '../output/print-error.ts';

export const askCommand: ICommandHandler = {
  name: 'ask',
  description:
    'Ask a question. Builds repository context, sends prompt to Claude (requires ANTHROPIC_API_KEY).',
  usage: 'shrk ask "<question>" [--max-tokens 3000] [--model claude-sonnet-4-6] [--dry-run]',
  async run(args: ParsedArgs): Promise<number> {
    const question = args.positional.join(' ').trim();
    if (!question) {
      process.stderr.write('Usage: shrk ask "<question>"\n');
      return 2;
    }
    const maxTokens = flagNumber(args, 'max-tokens') ?? 3000;
    const model = flagString(args, 'model');
    const dryRun = flagBool(args, 'dry-run');

    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const overview = buildProjectOverview(inspection.workspace, inspection.config?.projectName);
    const ctx = buildContext(inspection.knowledgeEntries, {
      task: question,
      maxTokens,
      projectOverview: renderOverviewText(overview),
    });

    const messages = buildPromptMessages({
      systemPreamble:
        'You are an AI engineer working in a SharkCraft-instrumented repository. Use the supplied repository context as authoritative ground truth. Quote knowledge entry ids you used.',
      context: ctx.body,
      task: question,
    });

    if (dryRun) {
      process.stdout.write(header('Prompt (dry-run)'));
      for (const m of messages) {
        process.stdout.write(`\n[${m.role}]\n${m.content}\n`);
      }
      return 0;
    }

    const provider = new ClaudeProvider();
    if (model) provider.configure({ model });
    if (!provider.isReady()) {
      process.stderr.write(
        'ANTHROPIC_API_KEY is not set. Use --dry-run to print the prompt instead.\n',
      );
      return 1;
    }

    const res = await provider.send({
      messages: [...messages, { role: AiMessageRole.User, content: question }],
      maxTokens: 1024,
      model,
    });
    if (!res.ok) {
      printError(res.error);
      return 1;
    }
    process.stdout.write(res.value.content + '\n');
    return 0;
  },
};
