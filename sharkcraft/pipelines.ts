// Engine-internal pipelines.
//
// One pipeline only: the canonical engine-feature-dev flow. It captures the
// plan → review → apply → typecheck → test → doctor → boundaries loop that
// is already in CLAUDE.md and the `sharkcraft-dev` skill — having it here
// makes it discoverable via `shrk pipelines list` and lets the context
// builder render it as a preferred flow.
//
// Plain default-exported array (no `@shrkcrft/pipelines` import — see
// sharkcraft.config.ts).

export default [
  {
    id: 'engine.feature-dev',
    title: 'Engine feature development',
    description:
      'The canonical loop for adding a feature to the SharkCraft engine itself: load context → classify → plan → review → apply with verification → typecheck → test → doctor → boundaries.',
    tags: ['engine', 'feature', 'generation'],
    appliesWhen: ['create-feature', 'add-feature', 'add-cli-command', 'add-mcp-tool'],
    inputs: [
      {
        name: 'task',
        required: true,
        description: 'One-sentence summary of the feature.',
      },
      {
        name: 'templateId',
        required: false,
        description: 'Template id to scaffold from (e.g. engine.cli-command, engine.mcp-tool). Omit for hand-written changes.',
      },
      {
        name: 'name',
        required: false,
        description: 'Kebab-case name of the new construct. Required when templateId is set.',
      },
    ],
    steps: [
      {
        // R57 — optional prelude: scaffold a spec for non-trivial features.
        // The spec is the intent artifact; for tiny features (1-file fixes,
        // typos) skip this and go straight to context.
        id: 'spec-create',
        type: 'command',
        description:
          'For non-trivial features, scaffold a spec under .sharkcraft/specs/. The spec becomes the signed intent artifact; later steps reference it.',
        cliCommands: [
          'bun run shrk spec create "<task>" --write',
        ],
        references: ['engine.docs'],
        enabledWhen: 'spec',
        humanReview: true,
      },
      {
        id: 'context',
        type: 'context',
        description: 'Token-budgeted, task-specific context: rules, paths, templates, pipelines.',
        cliCommands: ['bun run shrk context --task "<task>" --max-tokens 4000'],
        mcpTools: ['inspect_workspace', 'get_relevant_context'],
        references: ['repo.discovery.read-examples-first', 'engine.packages'],
        required: true,
      },
      {
        id: 'rules',
        type: 'mcp-tool',
        description: 'Surface relevant rules + their action hints.',
        mcpTools: ['get_relevant_rules', 'get_action_hints'],
        references: ['repo.architecture.respect-layer-order', 'repo.safety.mcp-is-read-only'],
        required: true,
      },
      {
        id: 'agent-plan',
        type: 'agent',
        description: 'Draft a short implementation plan against the retrieved rules. Quote rule ids.',
        instruction:
          'Draft a 3-7 step implementation plan. For each step, cite the rule id(s) and path convention id(s) it satisfies. Identify whether scaffolding via a template is appropriate; if so, name the templateId.',
        references: ['repo.scope.no-unrelated-changes'],
        required: true,
        humanReview: true,
      },
      {
        id: 'pick-template',
        type: 'mcp-tool',
        description: 'Identify or inspect the template, if scaffolding.',
        mcpTools: ['list_templates', 'get_template'],
        references: ['engine.cli-command', 'engine.mcp-tool'],
        enabledWhen: 'templateId',
      },
      {
        id: 'generation-plan',
        type: 'generation-plan',
        description: 'Produce a signed, dry-run plan. No files written yet.',
        cliCommands: [
          'bun run shrk gen <templateId> <name> --dry-run --save-plan /tmp/plan.json',
        ],
        mcpTools: ['create_generation_plan'],
        references: ['repo.generation.dry-run-by-default', 'engine.cli-command', 'engine.mcp-tool'],
        enabledWhen: 'templateId',
        required: false,
        humanReview: true,
      },
      {
        id: 'plan-review',
        type: 'command',
        description: 'Surface conflicts, divergence, and boundary impact before apply.',
        cliCommands: ['bun run shrk plan review /tmp/plan.json'],
        enabledWhen: 'templateId',
        required: false,
        humanReview: true,
      },
      {
        id: 'apply',
        type: 'apply-plan',
        description: 'Apply with signature verification AND verification gates (typecheck + tests).',
        cliCommands: [
          'bun run shrk apply /tmp/plan.json --verify-signature --validate --verification typecheck --verification unit-tests',
        ],
        references: ['repo.generation.dry-run-by-default'],
        enabledWhen: 'templateId',
        required: false,
        humanReview: true,
      },
      {
        id: 'typecheck',
        type: 'command',
        description: 'Strict noEmit typecheck across the workspace.',
        cliCommands: ['bun x tsc -p tsconfig.base.json --noEmit'],
        required: true,
      },
      {
        id: 'test',
        type: 'command',
        description: 'Bun test suite. Cheap; run it.',
        cliCommands: ['bun test'],
        references: ['repo.testing.bun-only'],
        required: true,
      },
      {
        id: 'doctor',
        type: 'command',
        description: 'Reload-time sanity check on sharkcraft/ entries.',
        cliCommands: ['bun run shrk doctor'],
        required: true,
      },
      {
        id: 'boundaries',
        type: 'command',
        description: 'Mechanical layer-order enforcement.',
        cliCommands: ['bun run shrk check boundaries'],
        references: ['repo.architecture.respect-layer-order'],
        required: true,
      },
      {
        // R57 — optional postlude: close the spec loop. If the feature
        // was driven by a spec (the prelude ran), verify it now to
        // record acceptance-criteria coverage + scope drift.
        id: 'spec-verify',
        type: 'command',
        description:
          'For features driven by a spec, run `shrk spec verify <id>` to confirm acceptance criteria + boundaries against the implementation diff.',
        cliCommands: ['bun run shrk spec verify <spec-id> --write'],
        references: ['engine.docs'],
        enabledWhen: 'spec',
        humanReview: false,
      },
    ],
    notes: [
      'Writes happen only via `shrk apply`. MCP never writes.',
      'If the change touches release behavior, packs, or signing, also run `bun run release:preflight`.',
      'If the change introduces a schema field consumers will need to adopt, update the pack-author docs so consumers can pick it up.',
      'R57: non-trivial features should be driven by `shrk spec create` → review → implement → verify. The spec stays in `.sharkcraft/specs/` as the audit trail.',
    ],
  },
];
