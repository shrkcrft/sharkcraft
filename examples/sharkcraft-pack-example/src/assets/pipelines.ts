export const examplePipeline = {
  id: 'pack.example.greeting-flow',
  title: 'Pack example greeting flow',
  description: 'Generate a greeting utility via the pack-contributed template. Plan → review → apply → verify.',
  tags: ['example', 'pack'],
  appliesWhen: ['generate-utility'],
  inputs: [
    { name: 'name', required: true },
  ],
  steps: [
    {
      id: 'plan',
      type: 'generation-plan',
      mcpTools: ['create_generation_plan'],
      cliCommands: [
        'shrk gen pack.example.greeting <name> --dry-run --save-plan <plan.json>',
      ],
      humanReview: true,
    },
    {
      id: 'apply',
      type: 'apply-plan',
      cliCommands: ['shrk apply <plan.json>'],
      humanReview: true,
    },
    {
      id: 'verify',
      type: 'command',
      cliCommands: ['bun test'],
    },
  ],
};

export default [examplePipeline];
