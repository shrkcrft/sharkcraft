import { definePlaybook } from '@shrkcrft/plugin-api';

export default [
  definePlaybook({
    id: 'add-service',
    title: 'Add a new HTTP service',
    description:
      'Generate a service skeleton, add a route, wire validation, and add tests.',
    tags: ['service', 'http', 'scaffold'],
    taskKinds: ['generate', 'feature'],
    recommendedTemplateIds: ['typescript.service', 'typescript.test'],
    recommendedPipelineIds: ['gen-feature-flow'],
    examples: ['generate a user profile service', 'add a payments service'],
    outputs: [
      'src/services/<name>.service.ts',
      'tests/services/<name>.spec.ts',
    ],
    steps: [
      {
        id: 'context',
        title: 'Load context',
        commands: ['shrk context --task "<task>"', 'shrk task "<task>"'],
      },
      {
        id: 'plan',
        title: 'Dry-run generate',
        commands: ['shrk gen typescript.service <name> --dry-run --save-plan /tmp/plan.json'],
      },
      {
        id: 'review',
        title: 'Review the plan',
        commands: ['shrk plan review /tmp/plan.json'],
        humanReview: true,
      },
      {
        id: 'apply',
        title: 'Apply (human approval required)',
        commands: ['shrk apply /tmp/plan.json --verify-signature'],
        humanReview: true,
        verificationCommands: ['bun test', 'shrk check boundaries'],
        safetyNotes: ['SharkCraft never auto-applies — this step requires explicit human action.'],
      },
    ],
  }),
];
