import { buildTaskPacket } from '@shrkcrft/inspector';
import {
  SemanticIndex,
  TaskType,
  buildFocusedContext,
  classifyTask,
  parseTaskTypeOverride,
} from '@shrkcrft/embeddings';
import type { IToolDefinition } from '../server/tool-definition.ts';
import { FORMAT_INPUT_PROPERTY, formatObjectArrays } from '../server/columnar-format.ts';

/**
 * `smart_context_bundle` — read-only MCP surface for the focused
 * context bundle that `shrk smart-context --focused` builds.
 *
 * The agent calls this with a task string. The tool runs BGE-based
 * semantic search, declaration extraction, and re-ranking against
 * the existing on-disk embedding index, then returns the bundle as
 * JSON plus a hint pointing at the CLI commands the agent should
 * run next.
 *
 * No writes. No LLM calls. If the index has not been built yet the
 * tool returns a structured error pointing to
 * `shrk smart-context embeddings-build`.
 */
export const smartContextBundleTool: IToolDefinition = {
  name: 'smart_context_bundle',
  description:
    'Build a task-focused context bundle (semantic-ranked code blocks + rules + doc hits + validation commands). Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string' },
      taskType: { type: 'string' },
      maxBlocks: { type: 'number' },
      ...FORMAT_INPUT_PROPERTY,
    },
    required: ['task'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const task = typeof input['task'] === 'string' ? (input['task'] as string).trim() : '';
    if (task.length === 0) {
      return {
        data: {
          error: 'task is required',
        },
      };
    }
    const overrideRaw = typeof input['taskType'] === 'string' ? (input['taskType'] as string) : undefined;
    const taskTypeOverride = parseTaskTypeOverride(overrideRaw);
    const maxBlocks = typeof input['maxBlocks'] === 'number' ? (input['maxBlocks'] as number) : 10;

    const index = await SemanticIndex.tryLoad(ctx.cwd);
    if (!index) {
      return {
        data: {
          error: 'no-semantic-index',
          message:
            'The semantic index has not been built for this workspace yet. The agent should ask the human to run the CLI command below.',
          nextCommand: 'shrk smart-context embeddings-build',
        },
      };
    }

    const classification = taskTypeOverride
      ? { type: taskTypeOverride, confidence: 1, signals: ['override'], scores: {} }
      : classifyTask(task);

    const packet = buildTaskPacket(ctx.inspection, task, { maxTokens: 3500 });
    const focused = await buildFocusedContext({
      cwd: ctx.cwd,
      task,
      index,
      rules: packet.relevantRules,
      verificationCommands: packet.verificationCommands,
      maxBlocks: Math.max(2, Math.min(20, maxBlocks)),
    });

    return {
      data: {
        task,
        taskType: classification.type,
        classification: {
          type: classification.type,
          confidence: classification.confidence,
          signals: classification.signals.slice(0, 6),
        },
        focused: formatObjectArrays(
          {
            model: focused.model,
            approxTokens: focused.approxTokens,
            files: focused.files,
            rules: focused.rules,
            docHits: focused.docHits,
            verificationCommands: focused.verificationCommands,
          },
          input,
        ),
        nextCommands: nextCommandHints(task, classification.type),
        notes: [
          'This bundle is read-only. To turn the recommended MVP into starter files, the human should run `shrk smart-context "<task>" --focused --plan --save` followed by `shrk spike <slug>`.',
        ],
      },
    };
  },
};

function nextCommandHints(task: string, taskType: TaskType): readonly string[] {
  const quotedTask = JSON.stringify(task);
  if (taskType === TaskType.Architecture) {
    return [
      `shrk smart-context ${quotedTask} --focused --plan --save`,
      `shrk smart-context list   # find the saved slug`,
      `shrk spike <slug>          # scaffold the recommended MVP`,
    ];
  }
  if (taskType === TaskType.Investigation) {
    return [
      `shrk smart-context ${quotedTask} --focused --save`,
      `shrk graph why <a> <b>     # trace structural relationships`,
    ];
  }
  return [
    `shrk smart-context ${quotedTask} --focused --plan --save`,
    `shrk spike <slug>          # if the plan has a firstSpike`,
  ];
}
