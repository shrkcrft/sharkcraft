/**
 * Hand-written JSON Schemas for SharkCraft's external surfaces. We use these
 * for `shrk schemas list/get/write`. Inferring schemas from zod is also
 * possible (and would cover more types) but hand-written schemas are clearer
 * for the few types external tooling cares about.
 */

export const PackManifestSchema = {
  $schema: 'https://json-schema.org/draft-07/schema',
  $id: 'urn:sharkcraft:schemas:pack-manifest',
  title: 'SharkCraft Pack Manifest',
  type: 'object',
  additionalProperties: true,
  required: ['schema', 'info', 'contributions'],
  properties: {
    schema: { const: 'sharkcraft.pack/v1' },
    info: {
      type: 'object',
      required: ['name', 'version'],
      properties: {
        name: { type: 'string' },
        version: { type: 'string' },
        description: { type: 'string' },
        author: { type: 'string' },
        homepage: { type: 'string' },
        license: { type: 'string' },
      },
    },
    contributions: {
      type: 'object',
      properties: {
        knowledgeFiles: { type: 'array', items: { type: 'string' } },
        ruleFiles: { type: 'array', items: { type: 'string' } },
        pathFiles: { type: 'array', items: { type: 'string' } },
        templateFiles: { type: 'array', items: { type: 'string' } },
        pipelineFiles: { type: 'array', items: { type: 'string' } },
        docsFiles: { type: 'array', items: { type: 'string' } },
      },
    },
    postInstallNotes: { type: 'array', items: { type: 'string' } },
  },
} as const;

export const SavedPlanSchema = {
  $schema: 'https://json-schema.org/draft-07/schema',
  $id: 'urn:sharkcraft:schemas:saved-plan',
  title: 'SharkCraft Saved Plan',
  type: 'object',
  additionalProperties: false,
  required: ['schema', 'templateId', 'variables', 'projectRoot', 'createdAt'],
  properties: {
    schema: { const: 'sharkcraft.plan/v1' },
    templateId: { type: 'string', minLength: 1 },
    name: { type: 'string' },
    variables: {
      type: 'object',
      additionalProperties: { type: 'string' },
    },
    projectRoot: { type: 'string', minLength: 1 },
    createdAt: { type: 'string' },
    expectedChanges: {
      type: 'array',
      items: {
        type: 'object',
        required: ['type', 'relativePath', 'sizeBytes'],
        properties: {
          type: { type: 'string' },
          relativePath: { type: 'string' },
          sizeBytes: { type: 'integer', minimum: 0 },
        },
      },
    },
    note: { type: 'string' },
    signature: {
      type: 'object',
      required: ['algo', 'hmac', 'signedAt'],
      properties: {
        algo: { const: 'sha256' },
        hmac: { type: 'string', minLength: 1 },
        signedAt: { type: 'string' },
      },
    },
  },
} as const;

export const ActionHintsSchema = {
  $schema: 'https://json-schema.org/draft-07/schema',
  $id: 'urn:sharkcraft:schemas:action-hints',
  title: 'SharkCraft Action Hints',
  type: 'object',
  additionalProperties: false,
  properties: {
    commands: {
      type: 'array',
      items: {
        type: 'object',
        required: ['command'],
        properties: {
          command: { type: 'string' },
          purpose: { type: 'string' },
          when: { type: 'string' },
          required: { type: 'boolean' },
        },
      },
    },
    mcpTools: {
      type: 'array',
      items: {
        type: 'object',
        required: ['tool'],
        properties: {
          tool: { type: 'string' },
          purpose: { type: 'string' },
          when: { type: 'string' },
          required: { type: 'boolean' },
        },
      },
    },
    preferredFlow: { type: 'array', items: { type: 'string' } },
    forbiddenActions: { type: 'array', items: { type: 'string' } },
    relatedTemplates: { type: 'array', items: { type: 'string' } },
    relatedPathConventions: { type: 'array', items: { type: 'string' } },
    relatedKnowledge: { type: 'array', items: { type: 'string' } },
    verificationCommands: { type: 'array', items: { type: 'string' } },
    safetyNotes: { type: 'array', items: { type: 'string' } },
    requiresHumanReview: { type: 'boolean' },
    writePolicy: { enum: ['cli-only', 'mcp-allowed', 'none'] },
  },
} as const;

export const PipelineDefinitionSchema = {
  $schema: 'https://json-schema.org/draft-07/schema',
  $id: 'urn:sharkcraft:schemas:pipeline-definition',
  title: 'SharkCraft Pipeline Definition',
  type: 'object',
  required: ['id', 'title', 'description', 'steps'],
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    description: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    scope: { type: 'array', items: { type: 'string' } },
    appliesWhen: { type: 'array', items: { type: 'string' } },
    inputs: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          required: { type: 'boolean' },
          default: { type: 'string' },
          choices: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    steps: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['id', 'type'],
        properties: {
          id: { type: 'string' },
          type: {
            enum: ['context', 'agent', 'generation-plan', 'apply-plan', 'command', 'mcp-tool'],
          },
          description: { type: 'string' },
          mcpTools: { type: 'array', items: { type: 'string' } },
          cliCommands: { type: 'array', items: { type: 'string' } },
          instruction: { type: 'string' },
          required: { type: 'boolean' },
          humanReview: { type: 'boolean' },
          enabledWhen: { type: 'string' },
          references: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    notes: { type: 'array', items: { type: 'string' } },
  },
} as const;

export const KnowledgeEntrySchema = {
  $schema: 'https://json-schema.org/draft-07/schema',
  $id: 'urn:sharkcraft:schemas:knowledge-entry',
  title: 'SharkCraft Knowledge Entry',
  type: 'object',
  required: ['id', 'title', 'type', 'priority', 'content'],
  properties: {
    id: {
      type: 'string',
      pattern: '^[a-z0-9]+([.-][a-z0-9]+)*$',
    },
    title: { type: 'string' },
    type: {
      type: 'string',
      // Open enum — custom types are allowed.
    },
    priority: { enum: ['critical', 'high', 'medium', 'low'] },
    scope: { type: 'array', items: { type: 'string' } },
    tags: { type: 'array', items: { type: 'string' } },
    appliesWhen: { type: 'array', items: { type: 'string' } },
    content: { type: 'string' },
    summary: { type: 'string' },
    actionHints: { $ref: 'action-hints.json' },
  },
} as const;

export const AdoptionStateSchema = {
  $schema: 'https://json-schema.org/draft-07/schema',
  $id: 'urn:sharkcraft:schemas:adoption-state',
  title: 'SharkCraft Adoption State',
  type: 'object',
  required: ['schema', 'projectRoot', 'createdAt', 'updatedAt', 'patchPath'],
  properties: {
    schema: { const: 'sharkcraft.adoption-state/v1' },
    projectRoot: { type: 'string' },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
    sharkcraftVersion: { type: 'string' },
    command: { type: 'string' },
    sourceDraftFiles: {
      type: 'array',
      items: {
        type: 'object',
        required: ['relativePath', 'hash'],
        properties: { relativePath: { type: 'string' }, hash: { type: 'string' } },
      },
    },
    targetFiles: {
      type: 'array',
      items: {
        type: 'object',
        required: ['relativePath', 'hash'],
        properties: { relativePath: { type: 'string' }, hash: { type: 'string' } },
      },
    },
    generatedFiles: { type: 'array', items: { type: 'string' } },
    patchPath: { type: 'string' },
    summaryPath: { type: 'string' },
    reportPath: { type: 'string' },
    diffFormat: { enum: ['pseudo', 'unified'] },
    confidenceThreshold: { enum: ['high', 'medium', 'low'] },
    includedKinds: { type: 'array', items: { type: 'string' } },
    excludedKinds: { type: 'array', items: { type: 'string' } },
    categories: {
      type: 'object',
      additionalProperties: { type: 'array', items: { type: 'string' } },
    },
    freshness: {
      type: 'object',
      properties: {
        status: { enum: ['fresh', 'stale', 'unknown'] },
        staleReasons: { type: 'array', items: { type: 'string' } },
      },
    },
    warnings: { type: 'array', items: { type: 'string' } },
    nextCommands: { type: 'array', items: { type: 'string' } },
  },
} as const;

export const SmartContextExpansionRequestSchema = {
  $schema: 'https://json-schema.org/draft-07/schema',
  $id: 'urn:sharkcraft:schemas:smart-context-expansion-request',
  title: 'Smart Context Expansion Request',
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    filesToRead: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['target', 'why'],
        properties: {
          target: { type: 'string', minLength: 1 },
          why: { type: 'string', minLength: 1 },
        },
      },
    },
    similarPatterns: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['target', 'why'],
        properties: {
          target: { type: 'string', minLength: 1 },
          why: { type: 'string', minLength: 1 },
        },
      },
    },
    publicApiFiles: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['target', 'why'],
        properties: {
          target: { type: 'string', minLength: 1 },
          why: { type: 'string', minLength: 1 },
        },
      },
    },
    testsToInspect: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['target', 'why'],
        properties: {
          target: { type: 'string', minLength: 1 },
          why: { type: 'string', minLength: 1 },
        },
      },
    },
    architectureRules: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'why'],
        properties: {
          id: { type: 'string', minLength: 1 },
          why: { type: 'string', minLength: 1 },
        },
      },
    },
    riskyAreas: { type: 'array', items: { type: 'string' } },
    missingInformation: { type: 'array', items: { type: 'string' } },
  },
} as const;

export const SmartContextDetailedPlanSchema = {
  $schema: 'https://json-schema.org/draft-07/schema',
  $id: 'urn:sharkcraft:schemas:smart-context-detailed-plan',
  title: 'Smart Context Detailed Development Plan',
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'taskUnderstanding', 'likelyTechnicalApproach', 'handoffSummary'],
  properties: {
    summary: { type: 'string', minLength: 1 },
    taskUnderstanding: { type: 'string', minLength: 1 },
    likelyTechnicalApproach: { type: 'string', minLength: 1 },
    existingPatternsToFollow: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'why'],
        properties: {
          path: { type: 'string', minLength: 1 },
          why: { type: 'string', minLength: 1 },
        },
      },
    },
    filesToRead: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'why'],
        properties: {
          path: { type: 'string', minLength: 1 },
          why: { type: 'string', minLength: 1 },
        },
      },
    },
    likelyFilesToModify: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'why'],
        properties: {
          path: { type: 'string', minLength: 1 },
          why: { type: 'string', minLength: 1 },
        },
      },
    },
    filesToAvoid: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'why'],
        properties: {
          path: { type: 'string', minLength: 1 },
          why: { type: 'string', minLength: 1 },
        },
      },
    },
    publicApiFiles: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'why'],
        properties: {
          path: { type: 'string', minLength: 1 },
          why: { type: 'string', minLength: 1 },
        },
      },
    },
    testsToInspect: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'why'],
        properties: {
          path: { type: 'string', minLength: 1 },
          why: { type: 'string', minLength: 1 },
        },
      },
    },
    architectureConstraints: { type: 'array', items: { type: 'string' } },
    relatedRules: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'applyWhen'],
        properties: {
          id: { type: 'string', minLength: 1 },
          title: { type: 'string', minLength: 1 },
          applyWhen: { type: 'string', minLength: 1 },
        },
      },
    },
    relatedTemplates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'useFor'],
        properties: {
          id: { type: 'string', minLength: 1 },
          useFor: { type: 'string', minLength: 1 },
        },
      },
    },
    firstCommands: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['command', 'why'],
        properties: {
          command: { type: 'string', minLength: 1 },
          why: { type: 'string', minLength: 1 },
        },
      },
    },
    implementationSteps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['step', 'details'],
        properties: {
          step: { type: 'string', minLength: 1 },
          details: { type: 'string', minLength: 1 },
        },
      },
    },
    risks: { type: 'array', items: { type: 'string' } },
    unknowns: { type: 'array', items: { type: 'string' } },
    validationCommands: { type: 'array', items: { type: 'string' } },
    handoffSummary: { type: 'string', minLength: 1 },
  },
} as const;

export const AdoptionSummarySchema = {
  $schema: 'https://json-schema.org/draft-07/schema',
  $id: 'urn:sharkcraft:schemas:adoption-summary',
  title: 'SharkCraft Adoption Summary',
  type: 'object',
  required: ['confidence', 'summary', 'items', 'format', 'targets'],
  properties: {
    confidence: { enum: ['high', 'medium', 'low'] },
    summary: { type: 'object', additionalProperties: { type: 'integer' } },
    items: { type: 'array' },
    format: { enum: ['pseudo', 'unified'] },
    targets: { type: 'array' },
  },
} as const;

export const ScaffoldPatternSchema = {
  $schema: 'https://json-schema.org/draft-07/schema',
  $id: 'urn:sharkcraft:schemas:scaffold-pattern',
  title: 'SharkCraft Scaffold Pattern',
  type: 'object',
  required: ['id', 'title', 'description', 'matchPaths', 'templateId', 'variables', 'appliesWhen', 'confidence'],
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    description: { type: 'string' },
    matchPaths: { type: 'array', items: { type: 'string' }, minItems: 1 },
    excludePaths: { type: 'array', items: { type: 'string' } },
    templateId: { type: 'string' },
    variables: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'from'],
        properties: {
          name: { type: 'string' },
          from: { type: 'string' },
          description: { type: 'string' },
        },
      },
    },
    appliesWhen: { type: 'array', items: { type: 'string' }, minItems: 1 },
    confidence: { enum: ['high', 'medium', 'low'] },
    tags: { type: 'array', items: { type: 'string' } },
    notes: { type: 'array', items: { type: 'string' } },
    requiredEvidence: { type: 'array', items: { type: 'string' } },
  },
} as const;

export const InferredTemplateCandidateV2Schema = {
  $schema: 'https://json-schema.org/draft-07/schema',
  $id: 'urn:sharkcraft:schemas:inferred-template-candidate-v2',
  title: 'SharkCraft Inferred Template Candidate v2',
  type: 'object',
  required: ['schema', 'sample'],
  properties: {
    schema: { const: 'sharkcraft.inferred-template-candidate/v2' },
    sample: { type: 'string' },
    matchedPattern: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        templateId: { type: 'string' },
        source: { type: 'string' },
        confidence: { enum: ['high', 'medium', 'low'] },
      },
    },
    scaffold: { type: 'object' },
    variables: { type: 'object', additionalProperties: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } },
    suggestedCommand: { type: 'string' },
  },
} as const;

export const QualityReportSchema = {
  $schema: 'https://json-schema.org/draft-07/schema',
  $id: 'urn:sharkcraft:schemas:quality-report',
  title: 'SharkCraft Quality Report',
  type: 'object',
  required: ['overall', 'gates', 'score'],
  properties: {
    overall: { enum: ['pass', 'warn', 'fail'] },
    blockers: { type: 'integer' },
    warnings: { type: 'integer' },
    score: { type: 'integer' },
    gates: { type: 'array' },
    drift: { type: 'object' },
    note: { type: 'string' },
    nextCommand: { type: 'string' },
    nextRecommendations: { type: 'array', items: { type: 'string' } },
  },
} as const;

export const SafetyAuditSchema = {
  $schema: 'https://json-schema.org/draft-07/schema',
  $id: 'urn:sharkcraft:schemas:safety-audit',
  title: 'SharkCraft Safety Audit',
  type: 'object',
  required: ['mcp', 'commands'],
  properties: {
    mcp: {
      type: 'object',
      properties: {
        anyWritable: { type: 'boolean' },
        tools: { type: 'array' },
      },
    },
    commands: { type: 'object' },
    verifications: { type: 'object' },
    packs: { type: 'object' },
    planSigning: { type: 'object' },
    recommendations: { type: 'array', items: { type: 'string' } },
  },
} as const;

export const DevSessionStateSchema = {
  $schema: 'https://json-schema.org/draft-07/schema',
  $id: 'urn:sharkcraft:schemas:dev-session-state',
  title: 'SharkCraft Dev Session State',
  type: 'object',
  required: ['schema', 'id', 'task', 'phase'],
  properties: {
    schema: { const: 'sharkcraft.dev-session/v1' },
    id: { type: 'string' },
    task: { type: 'string' },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
    phase: { type: 'string' },
    projectRoot: { type: 'string' },
    selectedPipeline: { type: ['string', 'null'] },
    selectedTemplates: { type: 'array', items: { type: 'string' } },
    plans: { type: 'array' },
    reports: { type: 'array', items: { type: 'string' } },
    validations: { type: 'array' },
    appliedPlans: { type: 'array' },
    nextAction: { type: ['string', 'null'] },
    warnings: { type: 'array', items: { type: 'string' } },
  },
} as const;

export const DashboardApiEnvelopeSchema = {
  $schema: 'https://json-schema.org/draft-07/schema',
  $id: 'urn:sharkcraft:schemas:dashboard-api-envelope',
  title: 'SharkCraft Dashboard API Envelope',
  type: 'object',
  required: ['schema', 'generatedAt', 'projectRoot', 'data'],
  properties: {
    schema: { const: 'sharkcraft.dashboard-api/v1' },
    generatedAt: { type: 'string' },
    projectRoot: { type: 'string', minLength: 1 },
    commandHints: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } },
    available: { type: 'boolean' },
    apiVersion: { type: 'string' },
    data: {},
  },
} as const;

export const DashboardOverviewResponseSchema = {
  $schema: 'https://json-schema.org/draft-07/schema',
  $id: 'urn:sharkcraft:schemas:dashboard-overview-response',
  title: 'SharkCraft Dashboard Overview Response',
  type: 'object',
  required: ['readiness', 'sharkcraftPresent', 'configPresent', 'summary', 'topRecommendations', 'featureAvailability'],
  properties: {
    readiness: {
      type: 'object',
      required: ['score', 'verdict'],
      properties: { score: { type: 'number' }, verdict: { type: 'string' } },
    },
    sharkcraftPresent: { type: 'boolean' },
    configPresent: { type: 'boolean' },
    summary: {
      type: 'object',
      properties: {
        rules: { type: 'integer' },
        paths: { type: 'integer' },
        templates: { type: 'integer' },
        pipelines: { type: 'integer' },
        presets: { type: 'integer' },
        packs: { type: 'integer' },
        scaffoldPatterns: { type: 'integer' },
        knowledgeEntries: { type: 'integer' },
      },
    },
    topRecommendations: { type: 'array', items: { type: 'string' } },
    featureAvailability: { type: 'object', additionalProperties: { type: 'boolean' } },
  },
} as const;

export const DashboardAdoptionResponseSchema = {
  $schema: 'https://json-schema.org/draft-07/schema',
  $id: 'urn:sharkcraft:schemas:dashboard-adoption-response',
  title: 'SharkCraft Dashboard Adoption Response',
  type: 'object',
  required: ['available', 'nextCommands', 'artifacts'],
  properties: {
    available: { type: 'boolean' },
    state: { type: 'object' },
    nextCommands: { type: 'array' },
    artifacts: { type: 'array' },
  },
} as const;

export const DashboardSessionResponseSchema = {
  $schema: 'https://json-schema.org/draft-07/schema',
  $id: 'urn:sharkcraft:schemas:dashboard-session-response',
  title: 'SharkCraft Dashboard Session Response',
  type: 'object',
  required: ['available', 'sessionId', 'artifacts', 'commandHints'],
  properties: {
    available: { type: 'boolean' },
    sessionId: { type: 'string' },
    task: { type: 'string' },
    status: { type: 'string' },
    startedAt: { type: 'string' },
    endedAt: { type: 'string' },
    artifacts: { type: 'array' },
    plans: { type: 'array' },
    reports: { type: 'array' },
    commandHints: { type: 'array' },
  },
} as const;

export const AdoptionMergePreviewSchema = {
  $schema: 'https://json-schema.org/draft-07/schema',
  $id: 'urn:sharkcraft:schemas:adoption-merge-preview',
  title: 'SharkCraft Adoption Merge Preview',
  type: 'object',
  required: ['schema', 'targets', 'safeBlocks', 'manualReview', 'lowConfidenceSkipped'],
  properties: {
    schema: { const: 'sharkcraft.adoption-merge-preview/v1' },
    targets: { type: 'array' },
    safeBlocks: { type: 'array' },
    manualReview: { type: 'array' },
    lowConfidenceSkipped: { type: 'array' },
    existingCoverage: { type: 'array' },
    conflicts: { type: 'array' },
    patchFreshness: { type: 'object' },
    recommendedCommands: { type: 'array', items: { type: 'string' } },
  },
} as const;

export const AdoptionReportSchema = {
  $schema: 'https://json-schema.org/draft-07/schema',
  $id: 'urn:sharkcraft:schemas:adoption-report',
  title: 'SharkCraft Adoption Report',
  type: 'object',
  required: ['schema'],
  properties: {
    schema: { const: 'sharkcraft.adoption-report/v1' },
    summary: { type: 'object' },
    categories: { type: 'object' },
    targets: { type: 'array' },
    patchPath: { type: 'string' },
    safeToAdopt: { type: 'array' },
    manualReview: { type: 'array' },
    conflicts: { type: 'array' },
    lowConfidence: { type: 'array' },
    recommendedCommands: { type: 'array', items: { type: 'string' } },
    safetyModel: { type: 'object' },
  },
} as const;

export const FeatureBundleSchema = {
  $schema: 'https://json-schema.org/draft-07/schema',
  $id: 'urn:sharkcraft:schemas:feature-bundle',
  title: 'SharkCraft Feature Workflow Bundle',
  type: 'object',
  additionalProperties: true,
  required: ['schema', 'id', 'task', 'status'],
  properties: {
    schema: { const: 'sharkcraft.feature-bundle/v1' },
    id: { type: 'string' },
    task: { type: 'string' },
    status: { type: 'string' },
    plans: { type: 'array' },
    planGroups: { type: 'array' },
    dependencies: { type: 'array' },
    validations: { type: 'array' },
    affectedFiles: { type: 'array', items: { type: 'string' } },
    affectedAreas: { type: 'array', items: { type: 'string' } },
    riskLevel: { type: 'string' },
    nextAction: { type: ['string', 'null'] },
  },
} as const;

export const PlanDependencyGraphSchema = {
  $schema: 'https://json-schema.org/draft-07/schema',
  $id: 'urn:sharkcraft:schemas:plan-dependency-graph',
  title: 'SharkCraft Plan Dependency Graph',
  type: 'object',
  required: ['schema', 'bundleId', 'nodes', 'edges'],
  properties: {
    schema: { const: 'sharkcraft.plan-dependency-graph/v1' },
    bundleId: { type: 'string' },
    nodes: { type: 'array' },
    edges: { type: 'array' },
    order: { type: 'array' },
  },
} as const;

export const AreaMapSchema = {
  $schema: 'https://json-schema.org/draft-07/schema',
  $id: 'urn:sharkcraft:schemas:area-map',
  title: 'SharkCraft Repository Area Map',
  type: 'object',
  required: ['schema', 'projectRoot', 'areas'],
  properties: {
    schema: { const: 'sharkcraft.area-map/v1' },
    projectRoot: { type: 'string' },
    areas: { type: 'array' },
    unclassifiedFiles: { type: 'integer' },
  },
} as const;

export const ImpactAnalysisSchema = {
  $schema: 'https://json-schema.org/draft-07/schema',
  $id: 'urn:sharkcraft:schemas:impact-analysis',
  title: 'SharkCraft Impact Analysis',
  type: 'object',
  required: ['schema', 'task'],
  properties: {
    schema: { const: 'sharkcraft.impact-analysis/v1' },
    task: { type: 'string' },
    risk: { type: 'string' },
    affectedFiles: { type: 'array' },
    affectedAreas: { type: 'array' },
  },
} as const;

export const TestImpactSchema = {
  $schema: 'https://json-schema.org/draft-07/schema',
  $id: 'urn:sharkcraft:schemas:test-impact',
  title: 'SharkCraft Test Impact',
  type: 'object',
  required: ['schema'],
  properties: {
    schema: { const: 'sharkcraft.test-impact/v1' },
    likelyTestFiles: { type: 'array' },
    missingTestFiles: { type: 'array' },
    confidence: { type: 'integer' },
  },
} as const;

export const OwnershipRuleSchema = {
  $schema: 'https://json-schema.org/draft-07/schema',
  $id: 'urn:sharkcraft:schemas:ownership-rule',
  title: 'SharkCraft Ownership Rule',
  type: 'object',
  required: ['id', 'title', 'paths', 'owners'],
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    paths: { type: 'array', items: { type: 'string' } },
    owners: { type: 'array', items: { type: 'string' } },
    reviewers: { type: 'array', items: { type: 'string' } },
    requiredReview: { type: 'boolean' },
  },
} as const;

export const PolicyReportSchema = {
  $schema: 'https://json-schema.org/draft-07/schema',
  $id: 'urn:sharkcraft:schemas:policy-report',
  title: 'SharkCraft Policy Report',
  type: 'object',
  required: ['schema', 'checks', 'summary'],
  properties: {
    schema: { const: 'sharkcraft.policy-report/v1' },
    checks: { type: 'array' },
    summary: { type: 'object' },
  },
} as const;

export const QualityBaselineSchema = {
  $schema: 'https://json-schema.org/draft-07/schema',
  $id: 'urn:sharkcraft:schemas:quality-baseline',
  title: 'SharkCraft Quality Baseline',
  type: 'object',
  required: ['schema', 'createdAt', 'qualityScore'],
  properties: {
    schema: { const: 'sharkcraft.quality-baseline/v1' },
    createdAt: { type: 'string' },
    qualityScore: { type: 'number' },
    blockers: { type: 'integer' },
    warnings: { type: 'integer' },
    gates: { type: 'array' },
  },
} as const;

export const DriftBaselineSchema = {
  $schema: 'https://json-schema.org/draft-07/schema',
  $id: 'urn:sharkcraft:schemas:drift-baseline',
  title: 'SharkCraft Drift Baseline',
  type: 'object',
  required: ['schema', 'findings'],
  properties: {
    schema: { const: 'sharkcraft.drift-baseline/v1' },
    findings: { type: 'array' },
  },
} as const;

export const ReviewPacketV2Schema = {
  $schema: 'https://json-schema.org/draft-07/schema',
  $id: 'urn:sharkcraft:schemas:review-packet-v2',
  title: 'SharkCraft Review Packet v2',
  type: 'object',
  required: ['schema', 'base', 'impact'],
  properties: {
    schema: { const: 'sharkcraft.review-packet-v2/v1' },
    base: { type: 'object' },
    impact: { type: 'object' },
    testImpact: { type: 'object' },
    ownership: { type: 'object' },
    policy: { type: 'object' },
    riskScore: { type: 'integer' },
  },
} as const;

export const PackCompatibilitySchema = {
  $schema: 'https://json-schema.org/draft-07/schema',
  $id: 'urn:sharkcraft:schemas:pack-compatibility',
  title: 'SharkCraft Pack Compatibility',
  type: 'object',
  required: ['schema', 'packageName', 'overall'],
  properties: {
    schema: { const: 'sharkcraft.pack-compatibility/v1' },
    packageName: { type: 'string' },
    overall: { type: 'string' },
    hits: { type: 'array' },
  },
} as const;

export const PackQualityScoreSchema = {
  $schema: 'https://json-schema.org/draft-07/schema',
  $id: 'urn:sharkcraft:schemas:pack-quality-score',
  title: 'SharkCraft Pack Quality Score',
  type: 'object',
  required: ['schema', 'packageName', 'overall'],
  properties: {
    schema: { const: 'sharkcraft.pack-quality-score/v1' },
    packageName: { type: 'string' },
    overall: { type: 'integer' },
    dimensions: { type: 'array' },
  },
} as const;

export const ImportGraphAnalysisSchema = {
  $schema: 'https://json-schema.org/draft-07/schema',
  $id: 'urn:sharkcraft:schemas:import-graph-analysis',
  title: 'SharkCraft Import Graph Analysis',
  type: 'object',
  required: ['schema'],
  properties: {
    schema: { const: 'sharkcraft.import-graph-analysis/v1' },
    cycles: { type: 'array' },
    topFanIn: { type: 'array' },
    topFanOut: { type: 'array' },
    orphans: { type: 'array' },
  },
} as const;

export const AgentContractSchema = {
  $schema: 'https://json-schema.org/draft-07/schema',
  $id: 'urn:sharkcraft:schemas:agent-contract',
  title: 'SharkCraft Agent Contract',
  type: 'object',
  required: ['schema', 'task', 'role', 'mode'],
  properties: {
    schema: { const: 'sharkcraft.agent-contract/v1' },
    task: { type: 'string' },
    role: { type: 'string' },
    mode: { type: 'string' },
    allowedFiles: { type: 'array', items: { type: 'string' } },
    forbiddenFiles: { type: 'array', items: { type: 'string' } },
    allowedCommands: { type: 'array', items: { type: 'string' } },
    forbiddenCommands: { type: 'array', items: { type: 'string' } },
    requiredValidations: { type: 'array', items: { type: 'string' } },
    requiredReviews: { type: 'array', items: { type: 'string' } },
    requiredPlanReviews: { type: 'array', items: { type: 'string' } },
    humanApprovalGates: { type: 'array', items: { type: 'string' } },
    rollbackPlan: { type: 'array', items: { type: 'string' } },
    definitionOfDone: { type: 'array', items: { type: 'string' } },
  },
} as const;

export const PlanSimulationSchema = {
  $schema: 'https://json-schema.org/draft-07/schema',
  $id: 'urn:sharkcraft:schemas:plan-simulation',
  title: 'SharkCraft Plan Simulation Report',
  type: 'object',
  required: ['schema', 'source', 'planSchema', 'applyReadiness', 'files'],
  properties: {
    schema: { const: 'sharkcraft.plan-simulation/v1' },
    source: { type: 'string' },
    planSchema: { type: 'string' },
    applyReadiness: { type: 'string' },
    signature: { type: 'string' },
    files: { type: 'array' },
    potentialBoundaryConcerns: { type: 'array' },
    planIntroducedBoundaryConcerns: { type: 'array' },
  },
} as const;

export const RepoMemorySchema = {
  $schema: 'https://json-schema.org/draft-07/schema',
  $id: 'urn:sharkcraft:schemas:repo-memory',
  title: 'SharkCraft Repository Memory Index',
  type: 'object',
  required: ['schema', 'projectRoot', 'sourceCount'],
  properties: {
    schema: { const: 'sharkcraft.memory/v1' },
    projectRoot: { type: 'string' },
    sourceCount: { type: 'integer' },
    files: { type: 'array' },
    diagnostics: { type: 'array' },
  },
} as const;

export const HealingPlanSchema = {
  $schema: 'https://json-schema.org/draft-07/schema',
  $id: 'urn:sharkcraft:schemas:healing-plan',
  title: 'SharkCraft Healing Plan',
  type: 'object',
  required: ['schema', 'inputKind', 'confidence', 'recommendedCommands'],
  properties: {
    schema: { const: 'sharkcraft.healing-plan/v1' },
    inputKind: { type: 'string' },
    confidence: { type: 'string' },
    recommendedCommands: { type: 'array', items: { type: 'string' } },
    safeRecoverySteps: { type: 'array', items: { type: 'string' } },
    forbiddenQuickFixes: { type: 'array', items: { type: 'string' } },
  },
} as const;

export const ExecutionGraphSchema = {
  $schema: 'https://json-schema.org/draft-07/schema',
  $id: 'urn:sharkcraft:schemas:execution-graph',
  title: 'SharkCraft Task Execution Graph',
  type: 'object',
  required: ['schema', 'task', 'nodes', 'edges'],
  properties: {
    schema: { const: 'sharkcraft.execution-graph/v1' },
    task: { type: 'string' },
    nodes: { type: 'array' },
    edges: { type: 'array' },
  },
} as const;

export const ALL_SCHEMAS: Readonly<Record<string, unknown>> = Object.freeze({
  'pack-manifest': PackManifestSchema,
  'saved-plan': SavedPlanSchema,
  'action-hints': ActionHintsSchema,
  'pipeline-definition': PipelineDefinitionSchema,
  'knowledge-entry': KnowledgeEntrySchema,
  'adoption-state': AdoptionStateSchema,
  'adoption-summary': AdoptionSummarySchema,
  'adoption-merge-preview': AdoptionMergePreviewSchema,
  'adoption-report': AdoptionReportSchema,
  'scaffold-pattern': ScaffoldPatternSchema,
  'inferred-template-candidate-v2': InferredTemplateCandidateV2Schema,
  'quality-report': QualityReportSchema,
  'safety-audit': SafetyAuditSchema,
  'dev-session-state': DevSessionStateSchema,
  'dashboard-api-envelope': DashboardApiEnvelopeSchema,
  'dashboard-overview-response': DashboardOverviewResponseSchema,
  'dashboard-adoption-response': DashboardAdoptionResponseSchema,
  'dashboard-session-response': DashboardSessionResponseSchema,
  'feature-bundle': FeatureBundleSchema,
  'plan-dependency-graph': PlanDependencyGraphSchema,
  'area-map': AreaMapSchema,
  'impact-analysis': ImpactAnalysisSchema,
  'test-impact': TestImpactSchema,
  'ownership-rule': OwnershipRuleSchema,
  'policy-report': PolicyReportSchema,
  'quality-baseline': QualityBaselineSchema,
  'drift-baseline': DriftBaselineSchema,
  'review-packet-v2': ReviewPacketV2Schema,
  'pack-compatibility': PackCompatibilitySchema,
  'pack-quality-score': PackQualityScoreSchema,
  'import-graph-analysis': ImportGraphAnalysisSchema,
  'agent-contract': AgentContractSchema,
  'plan-simulation': PlanSimulationSchema,
  'repo-memory': RepoMemorySchema,
  'healing-plan': HealingPlanSchema,
  'execution-graph': ExecutionGraphSchema,
});
