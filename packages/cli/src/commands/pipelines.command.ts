import { inspectSharkcraft, buildProjectOverview, renderOverviewText } from '@shrkcrft/inspector';
import { buildContext } from '@shrkcrft/context';
import {
  findNextStep,
  formatPipelineCompact,
  formatPipelineFull,
  interpolatePipeline,
  renderPipelineScript,
  type IPipelineDefinition,
} from '@shrkcrft/pipelines';
import {
  flagBool,
  flagNumber,
  flagString,
  flagList,
  flagVars,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header, kv } from '../output/format-output.ts';

export const pipelinesListCommand: ICommandHandler = {
  name: 'list',
  description: 'List available pipelines.',
  usage: 'shrk pipelines list [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const list = inspection.pipelineRegistry.list();
    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson(
          list.map((p) => ({
            id: p.id,
            title: p.title,
            description: p.description,
            tags: p.tags ?? [],
            scope: p.scope ?? [],
            appliesWhen: p.appliesWhen ?? [],
            stepCount: p.steps.length,
          })),
        ) + '\n',
      );
      return 0;
    }
    process.stdout.write(header(`Pipelines (${list.length})`));
    for (const p of list) process.stdout.write(formatPipelineCompact(p) + '\n');
    return 0;
  },
};

export const pipelinesGetCommand: ICommandHandler = {
  name: 'get',
  description: 'Show one pipeline by id.',
  usage: 'shrk pipelines get <id> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk pipelines get <id>\n');
      return 2;
    }
    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const pipeline = inspection.pipelineRegistry.get(id);
    if (!pipeline) {
      process.stderr.write(`No pipeline with id "${id}".\n`);
      return 1;
    }
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(pipeline) + '\n');
      return 0;
    }
    process.stdout.write(formatPipelineFull(pipeline) + '\n');
    return 0;
  },
};

export const pipelinesContextCommand: ICommandHandler = {
  name: 'context',
  description:
    'Combine a pipeline with a task-specific context. Returns the pipeline + relevant rules/paths/templates for the task.',
  usage: 'shrk pipelines context <id> --task "<task>" [--max-tokens 3000] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk pipelines context <id> --task "<task>"\n');
      return 2;
    }
    const task = flagString(args, 'task');
    if (!task) {
      process.stderr.write('Missing --task\n');
      return 2;
    }
    const maxTokens = flagNumber(args, 'max-tokens') ?? flagNumber(args, 'maxTokens') ?? 3000;
    const scope = flagList(args, 'scope');

    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const pipeline = inspection.pipelineRegistry.get(id);
    if (!pipeline) {
      process.stderr.write(`No pipeline with id "${id}".\n`);
      return 1;
    }

    const overview = buildProjectOverview(inspection.workspace, inspection.config?.projectName);
    const ctxResult = buildContext(inspection.knowledgeEntries, {
      task,
      scope,
      maxTokens,
      projectOverview: renderOverviewText(overview),
    });

    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({
          pipeline,
          context: ctxResult,
        }) + '\n',
      );
      return 0;
    }

    process.stdout.write(header(`Pipeline + context: ${pipeline.id}`));
    process.stdout.write(formatPipelineFull(pipeline) + '\n');
    process.stdout.write('\n');
    process.stdout.write(header(`Task context: ${task}`));
    process.stdout.write(
      `tokens ≈ ${ctxResult.totalTokens} / ${ctxResult.maxTokens}, sections: ${ctxResult.sections.length}\n\n`,
    );
    process.stdout.write(ctxResult.body + '\n');
    return 0;
  },
};

export const pipelinesPlanCommand: ICommandHandler = {
  name: 'plan',
  description:
    'Describe what running the pipeline would do for the given task. Does not execute anything.',
  usage: 'shrk pipelines plan <id> --task "<task>" [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk pipelines plan <id> --task "<task>"\n');
      return 2;
    }
    const task = flagString(args, 'task') ?? '<task>';
    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const pipeline = inspection.pipelineRegistry.get(id);
    if (!pipeline) {
      process.stderr.write(`No pipeline with id "${id}".\n`);
      return 1;
    }

    const interpolated = pipeline.steps.map((step) => ({
      id: step.id,
      type: step.type,
      description: step.description,
      required: step.required !== false,
      humanReview: step.humanReview === true,
      enabledWhen: step.enabledWhen,
      instruction: step.instruction
        ? step.instruction.replace(/<task>/g, task)
        : undefined,
      mcpTools: step.mcpTools ?? [],
      cliCommands: (step.cliCommands ?? []).map((c) => c.replace(/<task>/g, task)),
      references: step.references ?? [],
    }));

    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({
          pipeline: { id: pipeline.id, title: pipeline.title, description: pipeline.description },
          task,
          steps: interpolated,
        }) + '\n',
      );
      return 0;
    }

    process.stdout.write(header(`Plan: ${pipeline.title} (task: ${task})`));
    for (let i = 0; i < interpolated.length; i += 1) {
      const step = interpolated[i]!;
      const req = step.required ? '' : ' (optional)';
      const review = step.humanReview ? ' — human review' : '';
      const when = step.enabledWhen ? ` — when ${step.enabledWhen}` : '';
      process.stdout.write(`\n${i + 1}. [${step.type}] ${step.id}${req}${review}${when}\n`);
      if (step.description) process.stdout.write(`     ${step.description}\n`);
      if (step.instruction) process.stdout.write(`     instruction: ${step.instruction}\n`);
      if (step.mcpTools.length) process.stdout.write(`     mcpTools: ${step.mcpTools.join(', ')}\n`);
      for (const c of step.cliCommands) process.stdout.write(`     $ ${c}\n`);
      if (step.references.length) {
        process.stdout.write(`     references: ${step.references.join(', ')}\n`);
      }
    }
    process.stdout.write('\n');
    return 0;
  },
};

export const pipelinesScriptCommand: ICommandHandler = {
  name: 'script',
  description:
    'Render a copy-pasteable shell script for the pipeline. apply/write steps include a manual-confirm prompt.',
  usage:
    'shrk pipelines script <id> --task "<task>" [--var key=value ...] [--include-optional <stepId>] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk pipelines script <id> --task "<task>"\n');
      return 2;
    }
    const task = flagString(args, 'task') ?? '<task>';
    const inputs = flagVars(args);
    const includeOptionalList = flagList(args, 'include-optional');

    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const pipeline = inspection.pipelineRegistry.get(id);
    if (!pipeline) {
      process.stderr.write(`No pipeline with id "${id}".\n`);
      return 1;
    }
    const interp = interpolatePipeline(pipeline, {
      task,
      projectRoot: inspection.projectRoot,
      inputs,
      includeOptional: includeOptionalList,
    });
    const script = renderPipelineScript(interp);
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson({ pipelineId: pipeline.id, task, script }) + '\n');
      return 0;
    }
    process.stdout.write(script + '\n');
    return 0;
  },
};

export const pipelinesNextCommand: ICommandHandler = {
  name: 'next',
  description:
    'Return the next non-skipped step in the pipeline. Useful for "what should I do now?".',
  usage:
    'shrk pipelines next <id> --task "<task>" [--var key=value ...] [--include-optional <stepId>] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk pipelines next <id> --task "<task>"\n');
      return 2;
    }
    const task = flagString(args, 'task') ?? '<task>';
    const inputs = flagVars(args);
    const includeOptionalList = flagList(args, 'include-optional');

    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const pipeline = inspection.pipelineRegistry.get(id);
    if (!pipeline) {
      process.stderr.write(`No pipeline with id "${id}".\n`);
      return 1;
    }
    const interp = interpolatePipeline(pipeline, {
      task,
      projectRoot: inspection.projectRoot,
      inputs,
      includeOptional: includeOptionalList,
    });
    const next = findNextStep(interp);
    if (!next) {
      if (flagBool(args, 'json')) process.stdout.write('null\n');
      else process.stdout.write('(no remaining steps)\n');
      return 0;
    }
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(next) + '\n');
      return 0;
    }
    process.stdout.write(`Next step: [${next.type}] ${next.id}${next.humanReview ? ' — HUMAN REVIEW' : ''}\n`);
    if (next.description) process.stdout.write(`  ${next.description}\n`);
    if (next.instruction) process.stdout.write(`  instruction: ${next.instruction}\n`);
    if (next.mcpTools.length) process.stdout.write(`  mcpTools: ${next.mcpTools.join(', ')}\n`);
    for (const c of next.cliCommands) process.stdout.write(`  $ ${c}\n`);
    return 0;
  },
};

export const pipelinesVarsCommand: ICommandHandler = {
  name: 'vars',
  description:
    'Show the inputs a pipeline accepts (required/optional/defaults) plus optional steps.',
  usage: 'shrk [--cwd <dir>] pipelines vars <pipelineId> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk pipelines vars <pipelineId>\n');
      return 2;
    }
    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const pipeline = inspection.pipelineRegistry.get(id);
    if (!pipeline) {
      process.stderr.write(`No pipeline with id "${id}".\n`);
      return 1;
    }
    const optionalSteps = (pipeline.steps ?? []).filter((s) => s.required === false);
    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({
          id: pipeline.id,
          title: pipeline.title,
          inputs:
            pipeline.inputs?.map((v) => ({
              name: v.name,
              required: v.required ?? false,
              description: v.description ?? '',
              default: v.default,
              choices: v.choices ?? [],
            })) ?? [],
          optionalSteps: optionalSteps.map((s) => ({ id: s.id, description: s.description })),
        }) + '\n',
      );
      return 0;
    }
    process.stdout.write(header(`Pipeline inputs: ${pipeline.id}`));
    process.stdout.write(kv('title', pipeline.title) + '\n');
    process.stdout.write(kv('description', pipeline.description ?? '') + '\n\n');
    const inputs = pipeline.inputs ?? [];
    if (inputs.length === 0) {
      process.stdout.write('(no inputs)\n');
    }
    for (const v of inputs) {
      const tag = v.required ? '*required' : ' optional';
      process.stdout.write(`  ${tag}  ${v.name}\n`);
      if (v.description) process.stdout.write(`             ${v.description}\n`);
      if (v.default) process.stdout.write(`             default: ${v.default}\n`);
      if (v.choices?.length) {
        process.stdout.write(`             choices: ${v.choices.join(', ')}\n`);
      }
    }
    if (optionalSteps.length) {
      process.stdout.write('\nOptional steps (include with --include-optional):\n');
      for (const s of optionalSteps) {
        process.stdout.write(`  ${s.id}\n`);
        if (s.description) process.stdout.write(`    ${s.description}\n`);
      }
    }
    const sampleVars = inputs.map((v) => `--var ${v.name}=${v.default ?? '<value>'}`).join(' ');
    process.stdout.write(
      `\nExample:\n  $ shrk pipelines script ${pipeline.id} --task "<task>" ${sampleVars}\n`,
    );
    return 0;
  },
};
