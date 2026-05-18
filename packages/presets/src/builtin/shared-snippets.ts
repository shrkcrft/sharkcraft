// Reusable knowledge / rule / template / pipeline snippets shared across the
// built-in presets. Stored as raw TS source strings — they are injected into
// the synthesized sharkcraft/*.ts files verbatim.

export const COMMON_AGENT_BRIEFING = `defineKnowledgeEntry({
    id: 'agent.briefing',
    title: 'Agent briefing',
    type: KnowledgeType.Rule,
    priority: KnowledgePriority.Critical,
    tags: ['agent', 'safety'],
    appliesWhen: ['generate-code', 'refactor', 'fix-bug'],
    content: \`This repo uses SharkCraft. Use shrk CLI or the MCP server to read
context. Do not write files through MCP — use shrk apply on the CLI.\`,
    actionHints: {
      commands: [
        { command: 'shrk doctor' },
        { command: 'shrk context --task "<task>"' },
        { command: 'shrk gen <template> <name> --dry-run --save-plan <plan.json>' },
      ],
      mcpTools: ['get_relevant_context', 'get_action_hints', 'create_generation_plan'],
      forbiddenActions: [
        'Do not write files through MCP.',
        'Do not skip dry-run when generating new files.',
      ],
      verificationCommands: ['shrk doctor', 'bun x tsc --noEmit'],
      writePolicy: 'cli-only',
    },
  })`;

export const COMMON_SAFETY_RULE = `defineKnowledgeEntry({
    id: 'generation.dry-run-by-default',
    title: 'shrk gen is dry-run by default',
    type: KnowledgeType.Rule,
    priority: KnowledgePriority.Critical,
    tags: ['safety', 'generator'],
    appliesWhen: ['generate-code'],
    content: \`Always run shrk gen <id> <name> --dry-run first. Apply with
--write only after the plan is conflict-free. AI agents must call
create_generation_plan through MCP — they cannot write through MCP.\`,
    actionHints: {
      commands: [
        { command: 'shrk gen <id> <name> --dry-run --save-plan <plan.json>' },
        { command: 'shrk apply <plan.json> --verify-signature' },
      ],
      mcpTools: ['create_generation_plan', 'explain_generation_target'],
      forbiddenActions: ['Do not bypass dry-run.', 'Do not write through MCP.'],
      verificationCommands: ['shrk doctor'],
      writePolicy: 'cli-only',
    },
  })`;

export const COMMON_PIPELINE_FEATURE_DEV = `definePipeline({
    id: 'feature-dev',
    title: 'Feature development flow',
    description: 'Gather context → plan → dry-run gen → human review → apply.',
    tags: ['feature', 'generation'],
    inputs: [
      { name: 'task', required: true, description: 'Plain-English task description.' },
    ],
    steps: [
      {
        id: 'context',
        type: 'context',
        description: 'Pull relevant rules, paths, templates for the task.',
        cliCommands: ['shrk context --task "<task>" --max-tokens 3500'],
        mcpTools: ['get_relevant_context'],
      },
      {
        id: 'rules',
        type: 'mcp-tool',
        description: 'Confirm the rules that apply.',
        mcpTools: ['get_relevant_rules'],
      },
      {
        id: 'plan',
        type: 'generation-plan',
        description: 'Build a dry-run plan and save it for review.',
        cliCommands: [
          'shrk gen <template> <name> --dry-run --save-plan <plan.json>',
        ],
        humanReview: true,
      },
      {
        id: 'apply',
        type: 'apply-plan',
        description: 'Human applies the reviewed plan via CLI.',
        cliCommands: ['shrk apply <plan.json> --verify-signature'],
        humanReview: true,
      },
      {
        id: 'verify',
        type: 'command',
        description: 'Run verification commands.',
        cliCommands: ['shrk doctor', 'bun x tsc --noEmit'],
      },
    ],
  })`;

export const COMMON_PIPELINE_CONTEXT_ONLY = `definePipeline({
    id: 'context-only',
    title: 'Context-only flow',
    description: 'Retrieve the relevant slice without generating anything.',
    tags: ['safe', 'context'],
    inputs: [
      { name: 'task', required: true, description: 'Plain-English task description.' },
    ],
    steps: [
      {
        id: 'overview',
        type: 'mcp-tool',
        description: 'Project overview + readiness.',
        mcpTools: ['get_project_overview', 'get_ai_readiness_report'],
      },
      {
        id: 'context',
        type: 'context',
        description: 'Token-budgeted context for the task.',
        cliCommands: ['shrk context --task "<task>"'],
        mcpTools: ['get_relevant_context'],
      },
      {
        id: 'hints',
        type: 'mcp-tool',
        description: 'Per-task action hints.',
        mcpTools: ['get_action_hints'],
      },
    ],
  })`;

export const COMMON_PIPELINE_UNIT_TEST = `definePipeline({
    id: 'unit-test',
    title: 'Unit test verification',
    description: 'Run the project test suite as a verification step.',
    tags: ['test'],
    steps: [
      {
        id: 'test',
        type: 'command',
        description: 'Run unit tests.',
        cliCommands: ['bun test'],
      },
    ],
  })`;

export const COMMON_TEMPLATE_SERVICE = `defineTemplate({
    id: 'typescript.service',
    name: 'typescript-service',
    description: 'A minimal TypeScript service class with an init() method.',
    tags: ['typescript', 'service'],
    scope: ['app'],
    appliesWhen: ['generate-service'],
    variables: [
      {
        name: 'className',
        required: true,
        description: 'PascalCase class name (e.g. ProfileService).',
        pattern: /^[A-Z][A-Za-z0-9]+$/,
      },
    ],
    targetPath: (v) => \`src/services/\${kebab(v.className)}.service.ts\`,
    content: (v) => \`export class \${v.className} {\\n  init(): void {}\\n}\\n\`,
    postGenerationNotes: ['Wire the new service into your composition root when ready.'],
  })`;

export const COMMON_TEMPLATE_UTILITY = `defineTemplate({
    id: 'typescript.utility',
    name: 'typescript-utility',
    description: 'A pure utility module (one exported function per file).',
    tags: ['typescript', 'utility'],
    scope: ['app'],
    appliesWhen: ['generate-utility'],
    variables: [
      {
        name: 'functionName',
        required: true,
        description: 'camelCase function name (e.g. formatDate).',
        pattern: /^[a-z][A-Za-z0-9]+$/,
      },
    ],
    targetPath: (v) => \`src/utils/\${v.functionName}.ts\`,
    content: (v) => \`export function \${v.functionName}(): void {\\n  // TODO\\n}\\n\`,
  })`;

export const COMMON_TEMPLATE_TEST = `defineTemplate({
    id: 'typescript.unit-test',
    name: 'typescript-unit-test',
    description: 'A bun:test unit-test skeleton for an existing module.',
    tags: ['typescript', 'testing'],
    scope: ['app'],
    appliesWhen: ['generate-test'],
    variables: [
      {
        name: 'subject',
        required: true,
        description: 'Subject name (used in describe + filename).',
        pattern: /^[A-Za-z][A-Za-z0-9]+$/,
      },
    ],
    targetPath: (v) => \`tests/\${v.subject}.spec.ts\`,
    content: (v) =>
      \`import { describe, expect, test } from 'bun:test';\\n\\ndescribe('\${v.subject}', () => {\\n  test('placeholder', () => {\\n    expect(true).toBe(true);\\n  });\\n});\\n\`,
  })`;

// Helper available to template content. Defined at the top of templates.ts so
// each template can reference it. Adding it inline keeps generated files
// self-contained.
export const TEMPLATE_HELPERS = `function kebab(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .toLowerCase();
}`;

export const COMMON_PATH_SERVICES = `defineKnowledgeEntry({
    id: 'paths.services',
    title: 'Services live in src/services/',
    type: KnowledgeType.Path,
    priority: KnowledgePriority.High,
    tags: ['paths', 'services'],
    scope: ['app'],
    appliesWhen: ['generate-service'],
    content: 'Service classes live in src/services/. One service per file.',
    metadata: { path: 'src/services' },
  })`;

export const COMMON_PATH_UTILS = `defineKnowledgeEntry({
    id: 'paths.utils',
    title: 'Utilities live in src/utils/',
    type: KnowledgeType.Path,
    priority: KnowledgePriority.Medium,
    tags: ['paths', 'utils'],
    appliesWhen: ['generate-utility'],
    content: 'Pure helpers live in src/utils/. One function per file.',
    metadata: { path: 'src/utils' },
  })`;

export const COMMON_PATH_TESTS = `defineKnowledgeEntry({
    id: 'paths.tests',
    title: 'Tests live in tests/',
    type: KnowledgeType.Path,
    priority: KnowledgePriority.Medium,
    tags: ['paths', 'tests'],
    appliesWhen: ['generate-test'],
    content: 'Unit tests live under tests/, mirroring src/. Use *.spec.ts.',
    metadata: { path: 'tests' },
  })`;

export const COMMON_RULE_INTERFACE_PREFIX = `defineKnowledgeEntry({
    id: 'typescript.interfaces.i-prefix',
    title: 'Prefix interfaces with I',
    type: KnowledgeType.Rule,
    priority: KnowledgePriority.High,
    tags: ['typescript', 'naming'],
    appliesWhen: ['generate-code', 'refactor'],
    content: 'Interfaces use an I-prefix (IUser, IConfig). Enums are preferred over unions for closed sets.',
  })`;

export const COMMON_RULE_ONE_EXPORT = `defineKnowledgeEntry({
    id: 'typescript.files.one-export',
    title: 'One exported construct per file',
    type: KnowledgeType.Rule,
    priority: KnowledgePriority.High,
    tags: ['typescript', 'structure'],
    appliesWhen: ['generate-code'],
    content: 'Each TypeScript file exports exactly one top-level construct. Helpers live in their own file.',
  })`;

export const COMMON_RULE_NO_LOGIC_CONSTRUCTORS = `defineKnowledgeEntry({
    id: 'typescript.constructors.no-logic',
    title: 'No business logic in constructors',
    type: KnowledgeType.Rule,
    priority: KnowledgePriority.High,
    tags: ['typescript'],
    appliesWhen: ['generate-code'],
    content: 'Constructors wire dependencies only. Initialization belongs in init().',
  })`;

export const OVERVIEW_DOC = (title: string, body: string): string => `# ${title}

${body}

> Generated by \`shrk presets apply\`. SharkCraft (CLI + MCP) is the source of truth — this file is a human-readable companion.
`;
