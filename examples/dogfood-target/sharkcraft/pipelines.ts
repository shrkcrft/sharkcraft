// Pipelines for the dogfood-target example.
// Plain TS — the SharkCraft loader only requires { id, title, description, steps }.

export const contextOnly = {
  id: 'context-only',
  title: 'Context-only',
  description:
    'Retrieve task-specific rules, path conventions, and templates. No generation, no apply.',
  tags: ['safe', 'context'],
  appliesWhen: ['explore', 'plan'],
  inputs: [{ name: 'task', required: true }],
  steps: [
    {
      id: 'inspect',
      type: 'mcp-tool',
      mcpTools: ['inspect_workspace'],
      description: 'Confirm the target project root + framework detection.',
    },
    {
      id: 'briefing',
      type: 'mcp-tool',
      mcpTools: ['get_agent_instructions'],
      description: 'One-time agent briefing.',
    },
    {
      id: 'context',
      type: 'context',
      mcpTools: ['get_relevant_context'],
      cliCommands: ['shrk context --task "<task>" --max-tokens 3000'],
      description: 'Token-budgeted task-specific context.',
      required: true,
    },
    {
      id: 'hints',
      type: 'mcp-tool',
      mcpTools: ['get_action_hints'],
      description: 'Aggregate action hints from relevant entries.',
    },
  ],
};

export const featureDev = {
  id: 'feature-dev',
  title: 'Feature development flow',
  description:
    'Build context, draft an implementation plan, dry-run code generation, review with the human, apply through the CLI, then verify.',
  tags: ['feature', 'generation'],
  appliesWhen: ['create-feature', 'add-feature'],
  inputs: [
    { name: 'task', required: true },
    {
      name: 'includeMutationTesting',
      required: false,
      description: 'Set to "true" to add an optional mutation-test step at the end.',
      default: 'false',
      choices: ['true', 'false'],
    },
  ],
  steps: [
    {
      id: 'context',
      type: 'context',
      mcpTools: ['inspect_workspace', 'get_agent_instructions', 'get_relevant_context'],
      cliCommands: ['shrk context --task "<task>" --max-tokens 4000'],
      required: true,
    },
    {
      id: 'rules',
      type: 'mcp-tool',
      mcpTools: ['get_relevant_rules'],
      required: true,
    },
    {
      id: 'agent-plan',
      type: 'agent',
      instruction:
        'Draft a short implementation plan against the retrieved rules and path conventions. Quote the rule ids you used.',
      required: true,
      humanReview: true,
    },
    {
      id: 'pick-template',
      type: 'mcp-tool',
      mcpTools: ['list_templates', 'get_template'],
      description: 'Identify the right template for the change.',
    },
    {
      id: 'generation-plan',
      type: 'generation-plan',
      mcpTools: ['create_generation_plan'],
      cliCommands: ['shrk gen <templateId> <name> --dry-run --save-plan <plan.json>'],
      required: true,
      humanReview: true,
    },
    {
      id: 'apply',
      type: 'apply-plan',
      cliCommands: ['shrk apply <plan.json>'],
      required: true,
      humanReview: true,
    },
    {
      id: 'verify',
      type: 'command',
      cliCommands: [
        'bun x tsc -p tsconfig.json --noEmit',
        'bun test',
      ],
      required: true,
    },
    {
      id: 'mutation-test',
      type: 'command',
      cliCommands: ['bun run test:mutation'],
      required: false,
      enabledWhen: 'includeMutationTesting',
    },
  ],
  notes: [
    'Writes happen only via `shrk apply`. MCP never writes.',
    'Re-run `shrk doctor` before merging if the sharkcraft folder changed.',
  ],
};

export const safeGeneration = {
  id: 'safe-generation',
  title: 'Safe generation',
  description:
    'Run a template through dry-run → human review → apply. Refuses divergent or conflicting plans.',
  tags: ['safe', 'generation'],
  appliesWhen: ['generate-code'],
  inputs: [
    { name: 'templateId', required: true },
    { name: 'name', required: true },
  ],
  steps: [
    {
      id: 'inspect-template',
      type: 'mcp-tool',
      mcpTools: ['get_template'],
      required: true,
    },
    {
      id: 'plan',
      type: 'generation-plan',
      mcpTools: ['create_generation_plan'],
      cliCommands: ['shrk gen <templateId> <name> --dry-run --save-plan <plan.json>'],
      required: true,
      humanReview: true,
    },
    {
      id: 'apply',
      type: 'apply-plan',
      cliCommands: ['shrk apply <plan.json>'],
      required: true,
      humanReview: true,
    },
  ],
};

export const unitTest = {
  id: 'unit-test',
  title: 'Run unit tests',
  description: 'Just run the project test suite. Useful as a verify step in a larger flow.',
  tags: ['test'],
  appliesWhen: ['verify'],
  steps: [
    {
      id: 'bun-test',
      type: 'command',
      cliCommands: ['bun test'],
      required: true,
    },
  ],
};

export default [contextOnly, featureDev, safeGeneration, unitTest];
