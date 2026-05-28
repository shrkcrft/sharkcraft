// Engine-internal scaffold templates.
//
// Two templates only — both for constructs whose registration is rigid and
// frequently forgotten when hand-written:
//
//   * CLI command       → must be exported AND registered in main.ts via
//                         `registry.register(...)`.
//   * MCP tool          → must be exported AND added to `ALL_TOOLS` in
//                         `packages/mcp-server/src/tools/index.ts`.
//
// Both templates also pin the `I`-prefixed interface convention, the
// per-file single-export rule, and the `@shrkcrft/*` absolute-import rule.
//
// Plain default-exported array (no `@shrkcrft/templates` import — see
// sharkcraft.config.ts).

export default [
  {
    id: 'engine.cli-command',
    name: 'CLI command (shrk subcommand)',
    description:
      'Scaffold a new top-level `shrk` subcommand: a single file under `packages/cli/src/commands/<name>.command.ts` exporting an `ICommandHandler` named `<name>Command`.',
    tags: ['cli', 'engine'],
    scope: ['typescript', 'engine'],
    appliesWhen: ['create-feature', 'add-cli-command'],
    variables: [
      {
        name: 'name',
        required: true,
        description: 'kebab-case command name (e.g. "list-rules"). Used as the on-disk filename and the user-typed verb.',
        examples: ['list-rules'],
      },
      {
        name: 'camel',
        required: true,
        pattern: /^[a-z][A-Za-z0-9]*$/,
        description: 'camelCase identifier used for the exported handler constant (e.g. "listRules").',
      },
      {
        name: 'description',
        required: true,
        description: 'One-line user-facing description shown by `shrk --help`.',
        examples: ['List configured engine rules.'],
      },
    ],
    targetPath: ({ name }) => `packages/cli/src/commands/${name}.command.ts`,
    content: ({ name, camel, description }) => `import {
  flagBool,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header } from '../output/format-output.ts';

export const ${camel}Command: ICommandHandler = {
  name: '${name}',
  description: ${JSON.stringify(description)},
  usage: 'shrk [--cwd <dir>] ${name} [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    // TODO: implement. Use @shrkcrft/inspector for read-only inspection; the
    // CLI is the only place writes are allowed in this codebase.
    const result = { cwd, ok: true };

    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(result) + '\\n');
      return 0;
    }
    process.stdout.write(header('${name}'));
    process.stdout.write(JSON.stringify(result, null, 2) + '\\n');
    return 0;
  },
};
`,
    postGenerationNotes: [
      'Register the command in packages/cli/src/main.ts:',
      `  1. Add: import { ${'<camel>'}Command } from './commands/${'<name>'}.command.ts';`,
      `  2. Add: registry.register(${'<camel>'}Command); next to the other registry.register calls.`,
      'Mirror the closest sibling for arg parsing + output formatting. coverage.command.ts is a small, clean example.',
      'Add a focused test under packages/cli/src/__tests__/ exercising the --json branch at minimum.',
    ],
    related: [
      'repo.discovery.read-examples-first',
      'repo.architecture.respect-layer-order',
    ],
  },
  {
    id: 'engine.mcp-tool',
    name: 'MCP tool (read-only)',
    description:
      'Scaffold a new read-only MCP tool: a single file under `packages/mcp-server/src/tools/<name>.tool.ts` exporting an `IToolDefinition` named `<camel>Tool`. The handler must NOT write.',
    tags: ['mcp', 'engine', 'read-only'],
    scope: ['typescript', 'engine'],
    appliesWhen: ['create-feature', 'add-mcp-tool', 'expose-to-agents'],
    variables: [
      {
        name: 'name',
        required: true,
        description: 'kebab-case tool filename (e.g. "list-rules"). Used as the on-disk filename only.',
        examples: ['list-rules'],
      },
      {
        name: 'toolName',
        required: true,
        pattern: /^[a-z][a-z0-9_]*$/,
        description: 'snake_case tool name returned to the MCP client (e.g. "list_rules").',
      },
      {
        name: 'camel',
        required: true,
        pattern: /^[a-z][A-Za-z0-9]*$/,
        description: 'camelCase identifier used for the exported tool constant (e.g. "listRules").',
      },
      {
        name: 'description',
        required: true,
        description: 'One-line description shown to MCP clients. End with "Read-only." to make the contract explicit.',
        examples: ['List configured engine rules. Read-only.'],
      },
    ],
    targetPath: ({ name }) => `packages/mcp-server/src/tools/${name}.tool.ts`,
    content: ({ toolName, camel, description }) => `import type { IToolDefinition } from '../server/tool-definition.ts';

export const ${camel}Tool: IToolDefinition = {
  name: '${toolName}',
  description: ${JSON.stringify(description.endsWith('Read-only.') ? description : description + ' Read-only.')},
  inputSchema: {
    type: 'object',
    properties: {
      // TODO: add input properties here. Keep them strict and JSON-schema-shaped.
    },
    additionalProperties: false,
  },
  async handler(_input, ctx) {
    // Read-only by contract. NEVER call writeFile / mkdir / spawn-with-side-effects.
    // Use ctx.inspection.* (already populated) to answer the request.
    const data = {
      projectRoot: ctx.inspection.projectRoot,
      // TODO: replace with the real read-only payload.
    };
    return { data };
  },
};
`,
    postGenerationNotes: [
      'Register the tool in packages/mcp-server/src/tools/index.ts:',
      `  1. Add: import { ${'<camel>'}Tool } from './${'<name>'}.tool.ts';`,
      `  2. Add ${'<camel>'}Tool to the ALL_TOOLS array (keep it sorted near similar tools).`,
      'Add a test under packages/mcp-server/src/__tests__/ that asserts handler output shape AND zero filesystem writes.',
      'Verify the read-only contract: bun test e2e/20-read-only-safety.e2e.ts after building, if the tool surfaces in /api.',
    ],
    related: [
      'repo.safety.mcp-is-read-only',
      'repo.discovery.read-examples-first',
      'repo.architecture.respect-layer-order',
    ],
  },
];
