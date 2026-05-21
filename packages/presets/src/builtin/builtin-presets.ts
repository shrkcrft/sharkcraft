import { WorkspaceProfile } from '@shrkcrft/workspace';
import { definePreset } from '../define/define-preset.ts';
import type { IPreset } from '../model/preset.ts';
import {
  ANGULAR_PATH_APP,
  ANGULAR_PATH_COMPONENTS,
  ANGULAR_PATH_SERVICES,
  COMMON_AGENT_BRIEFING,
  COMMON_PATH_SERVICES,
  COMMON_PATH_TESTS,
  COMMON_PATH_UTILS,
  COMMON_PIPELINE_CONTEXT_ONLY,
  COMMON_PIPELINE_FEATURE_DEV,
  COMMON_PIPELINE_UNIT_TEST,
  COMMON_RULE_INTERFACE_PREFIX,
  COMMON_RULE_NO_LOGIC_CONSTRUCTORS,
  COMMON_RULE_ONE_EXPORT,
  COMMON_SAFETY_RULE,
  COMMON_TEMPLATE_SERVICE,
  COMMON_TEMPLATE_TEST,
  COMMON_TEMPLATE_UTILITY,
  GO_PATH_CMD,
  GO_PATH_INTERNAL,
  GO_PATH_PKG,
  JAVA_MAVEN_PATH_MAIN,
  JAVA_MAVEN_PATH_TESTS,
  NX_PATH_APPS,
  NX_PATH_LIBS,
  OVERVIEW_DOC,
  PYTHON_PATH_SRC,
  PYTHON_PATH_TESTS,
  RUST_PATH_SRC,
  RUST_PATH_TESTS,
} from './shared-snippets.ts';
import { MULTI_STACK_PRESETS } from './r26-presets.ts';
import { UNIVERSAL_ADOPTION_PRESETS } from './r45-presets.ts';
import { CANONICAL_ALIAS_PRESETS } from './r47-presets.ts';
import { ANGULAR_21_PRESETS } from './angular21-presets.ts';
import { NEST_11_PRESETS } from './nest11-presets.ts';
import { REACT_19_PRESETS } from './react19-presets.ts';

const GENERIC: IPreset = definePreset({
  id: 'generic',
  title: 'Generic SharkCraft setup',
  description: 'Universal SharkCraft starter — safe-codegen rule, basic context/feature pipelines, common path conventions, and an agent briefing.',
  tags: ['generic'],
  weight: 5,
  includes: {
    knowledge: [COMMON_AGENT_BRIEFING],
    rules: [COMMON_SAFETY_RULE],
    paths: [COMMON_PATH_SERVICES, COMMON_PATH_UTILS, COMMON_PATH_TESTS],
    templates: [COMMON_TEMPLATE_SERVICE, COMMON_TEMPLATE_UTILITY, COMMON_TEMPLATE_TEST],
    pipelines: [COMMON_PIPELINE_CONTEXT_ONLY, COMMON_PIPELINE_FEATURE_DEV, COMMON_PIPELINE_UNIT_TEST],
    docs: {
      'overview.md': OVERVIEW_DOC(
        'Project overview',
        'This repo uses SharkCraft to give AI coding agents structured project intelligence. Run `shrk doctor` to verify the setup.',
      ),
    },
    tasks: {
      'roadmap.md': '# Roadmap\n\n- [ ] First task\n',
    },
  },
  recommendedNextCommands: [
    'shrk doctor',
    'shrk context --task "<task>"',
    'shrk task "<task>"',
  ],
});

const TYPESCRIPT_LIBRARY: IPreset = definePreset({
  id: 'typescript-library',
  title: 'TypeScript library',
  description: 'Rules, templates and pipelines for a generic TypeScript library: I-prefix, one-export-per-file, no-logic constructors, utility template.',
  tags: ['typescript', 'library'],
  appliesTo: [WorkspaceProfile.HasTypeScript, WorkspaceProfile.IsLibrary],
  weight: 7,
  includes: {
    knowledge: [COMMON_AGENT_BRIEFING],
    rules: [
      COMMON_SAFETY_RULE,
      COMMON_RULE_INTERFACE_PREFIX,
      COMMON_RULE_ONE_EXPORT,
      COMMON_RULE_NO_LOGIC_CONSTRUCTORS,
    ],
    paths: [COMMON_PATH_UTILS, COMMON_PATH_TESTS],
    templates: [COMMON_TEMPLATE_UTILITY, COMMON_TEMPLATE_TEST],
    pipelines: [COMMON_PIPELINE_CONTEXT_ONLY, COMMON_PIPELINE_FEATURE_DEV, COMMON_PIPELINE_UNIT_TEST],
    docs: {
      'overview.md': OVERVIEW_DOC('TypeScript library', 'Strict typing, single-export files, no logic in constructors.'),
    },
  },
  recommendedNextCommands: [
    'shrk doctor',
    'shrk gen typescript.utility <name> --dry-run',
    'shrk task "<task>"',
  ],
});

const BUN_SERVICE: IPreset = definePreset({
  id: 'bun-service',
  title: 'Bun-native service',
  description: 'Bun-native HTTP service starter: feature-dev + safe-codegen, service/utility/test templates, bun test pipeline.',
  tags: ['bun', 'service'],
  appliesTo: [WorkspaceProfile.HasBun, WorkspaceProfile.IsBackend, WorkspaceProfile.IsService],
  weight: 7,
  includes: {
    knowledge: [COMMON_AGENT_BRIEFING],
    rules: [COMMON_SAFETY_RULE, COMMON_RULE_INTERFACE_PREFIX, COMMON_RULE_ONE_EXPORT],
    paths: [COMMON_PATH_SERVICES, COMMON_PATH_UTILS, COMMON_PATH_TESTS],
    templates: [COMMON_TEMPLATE_SERVICE, COMMON_TEMPLATE_UTILITY, COMMON_TEMPLATE_TEST],
    pipelines: [COMMON_PIPELINE_CONTEXT_ONLY, COMMON_PIPELINE_FEATURE_DEV, COMMON_PIPELINE_UNIT_TEST],
    docs: {
      'overview.md': OVERVIEW_DOC('Bun service', 'Bun-native HTTP service. Tests use bun test.'),
    },
  },
  recommendedNextCommands: [
    'shrk doctor',
    'shrk gen typescript.service <name> --dry-run',
    'shrk task "<task>"',
  ],
});

const NODE_API: IPreset = definePreset({
  id: 'node-api',
  title: 'Node API',
  description: 'Framework-agnostic Node API setup: HTTP route conventions, service-layer templates, common safety rules.',
  tags: ['node', 'api', 'backend'],
  appliesTo: [WorkspaceProfile.IsBackend, WorkspaceProfile.IsService],
  notAppropriateFor: [WorkspaceProfile.HasBun],
  weight: 6,
  includes: {
    knowledge: [COMMON_AGENT_BRIEFING],
    rules: [COMMON_SAFETY_RULE, COMMON_RULE_ONE_EXPORT],
    paths: [COMMON_PATH_SERVICES, COMMON_PATH_UTILS, COMMON_PATH_TESTS],
    templates: [COMMON_TEMPLATE_SERVICE, COMMON_TEMPLATE_TEST],
    pipelines: [COMMON_PIPELINE_CONTEXT_ONLY, COMMON_PIPELINE_FEATURE_DEV],
    docs: {
      'overview.md': OVERVIEW_DOC('Node API', 'Routes stay thin. Business logic lives in services.'),
    },
  },
  recommendedNextCommands: ['shrk doctor', 'shrk task "create a profile service"'],
});

const FRONTEND_APP: IPreset = definePreset({
  id: 'frontend-app',
  title: 'Frontend app',
  description: 'Framework-neutral frontend setup: component / hook / state conventions, safe-codegen, feature-dev pipeline.',
  tags: ['frontend'],
  appliesTo: [WorkspaceProfile.IsFrontend],
  weight: 6,
  includes: {
    knowledge: [COMMON_AGENT_BRIEFING],
    rules: [COMMON_SAFETY_RULE, COMMON_RULE_ONE_EXPORT],
    paths: [COMMON_PATH_UTILS, COMMON_PATH_TESTS],
    templates: [COMMON_TEMPLATE_UTILITY, COMMON_TEMPLATE_TEST],
    pipelines: [COMMON_PIPELINE_CONTEXT_ONLY, COMMON_PIPELINE_FEATURE_DEV],
    docs: {
      'overview.md': OVERVIEW_DOC('Frontend app', 'Component-based app. Keep components small; state separate.'),
    },
  },
  recommendedNextCommands: ['shrk doctor', 'shrk task "create a profile screen"'],
  surfaceProfile: 'small-app',
});

// Angular-flavored single-app preset. Selects the small-app surface
// profile by default so first-time users see the non-monorepo slice
// of the catalog.
const ANGULAR_APP: IPreset = definePreset({
  id: 'angular-app',
  title: 'Angular app',
  description: 'Single Angular workspace: component conventions, safe-codegen pipeline, small-app surface profile.',
  tags: ['frontend', 'angular'],
  appliesTo: [WorkspaceProfile.IsFrontend],
  weight: 7,
  includes: {
    knowledge: [COMMON_AGENT_BRIEFING],
    rules: [COMMON_SAFETY_RULE, COMMON_RULE_ONE_EXPORT],
    paths: [ANGULAR_PATH_APP, ANGULAR_PATH_COMPONENTS, ANGULAR_PATH_SERVICES],
    templates: [COMMON_TEMPLATE_UTILITY, COMMON_TEMPLATE_TEST],
    pipelines: [COMMON_PIPELINE_CONTEXT_ONLY, COMMON_PIPELINE_FEATURE_DEV],
    docs: {
      'overview.md': OVERVIEW_DOC('Angular app', 'Single Angular workspace. Components small; modules lazy; state colocated.'),
    },
  },
  recommendedNextCommands: [
    'shrk doctor',
    'shrk surface list   # see what is visible (small-app default)',
    'shrk task "create a profile screen"',
  ],
  surfaceProfile: 'small-app',
});

const NX_MONOREPO: IPreset = definePreset({
  id: 'nx-monorepo',
  title: 'Nx monorepo',
  description: 'Conventions for Nx workspaces: public entrypoints, no relative cross-lib imports, affected build/test commands.',
  tags: ['nx', 'monorepo'],
  appliesTo: [WorkspaceProfile.HasNx, WorkspaceProfile.IsMonorepo],
  weight: 8,
  includes: {
    knowledge: [
      COMMON_AGENT_BRIEFING,
      `defineKnowledgeEntry({
    id: 'nx.boundary-tags',
    title: 'Respect Nx boundary tags',
    type: KnowledgeType.Rule,
    priority: KnowledgePriority.Critical,
    tags: ['nx', 'architecture'],
    appliesWhen: ['generate-code', 'refactor'],
    content: 'Respect the boundary tags declared on each project (scope, type). The enforce-module-boundaries lint rule must stay green.',
  })`,
      `defineKnowledgeEntry({
    id: 'nx.public-entrypoints',
    title: 'Import via public entrypoints only',
    type: KnowledgeType.Rule,
    priority: KnowledgePriority.High,
    tags: ['nx', 'imports'],
    appliesWhen: ['generate-code'],
    content: 'Use absolute imports through @scope/<lib>; never reach into internal paths.',
  })`,
    ],
    rules: [COMMON_SAFETY_RULE, COMMON_RULE_INTERFACE_PREFIX, COMMON_RULE_ONE_EXPORT],
    paths: [NX_PATH_LIBS, NX_PATH_APPS],
    templates: [COMMON_TEMPLATE_SERVICE, COMMON_TEMPLATE_UTILITY, COMMON_TEMPLATE_TEST],
    pipelines: [COMMON_PIPELINE_CONTEXT_ONLY, COMMON_PIPELINE_FEATURE_DEV, COMMON_PIPELINE_UNIT_TEST],
    docs: {
      'overview.md': OVERVIEW_DOC('Nx monorepo', 'Many libraries. Layer order is enforced. Code lives under libs/<area>/src/lib/; apps under apps/<app>/.'),
    },
  },
  recommendedNextCommands: [
    'shrk doctor',
    'shrk task "create a service in libs/<area>"',
  ],
});

const MCP_SERVER_PRESET: IPreset = definePreset({
  id: 'mcp-server',
  title: 'MCP server project',
  description: 'For projects that build MCP servers (tools/resources/prompts). Encodes input-validation, no-write-server, and JSON-RPC framing rules.',
  tags: ['mcp', 'ai-agent'],
  appliesTo: [WorkspaceProfile.HasMcpSdk],
  weight: 8,
  includes: {
    knowledge: [
      COMMON_AGENT_BRIEFING,
      `defineKnowledgeEntry({
    id: 'mcp.no-writes',
    title: 'MCP servers must not write files',
    type: KnowledgeType.Rule,
    priority: KnowledgePriority.Critical,
    tags: ['mcp', 'safety'],
    appliesWhen: ['generate-code'],
    content: 'MCP tools return data only. Writes go through the CLI.',
    actionHints: {
      writePolicy: 'cli-only',
      forbiddenActions: ['Do not introduce file-writing tools to the MCP server.'],
      verificationCommands: ['shrk doctor'],
    },
  })`,
      `defineKnowledgeEntry({
    id: 'mcp.zod-validation',
    title: 'Validate all MCP inputs with zod',
    type: KnowledgeType.Rule,
    priority: KnowledgePriority.High,
    tags: ['mcp', 'security'],
    appliesWhen: ['generate-code'],
    content: 'Every tools/call input is validated at the boundary before reaching the handler.',
  })`,
    ],
    rules: [COMMON_SAFETY_RULE, COMMON_RULE_ONE_EXPORT],
    paths: [COMMON_PATH_TESTS],
    templates: [COMMON_TEMPLATE_TEST],
    pipelines: [COMMON_PIPELINE_CONTEXT_ONLY, COMMON_PIPELINE_FEATURE_DEV, COMMON_PIPELINE_UNIT_TEST],
    docs: {
      'overview.md': OVERVIEW_DOC('MCP server', 'MCP tools are read-only. Inputs are zod-validated.'),
    },
  },
  recommendedNextCommands: ['shrk doctor', 'shrk task "add a new MCP tool"'],
});

const AI_AGENT_READY: IPreset = definePreset({
  id: 'ai-agent-ready',
  title: 'AI-agent-ready baseline',
  description: 'Strong action-hint coverage, verification commands, forbidden actions — designed to make a repo high-readiness for Claude Code / Cursor.',
  tags: ['ai-agent', 'safety'],
  weight: 6,
  includes: {
    knowledge: [
      COMMON_AGENT_BRIEFING,
      `defineKnowledgeEntry({
    id: 'agent.preferred-flow',
    title: 'Agent preferred flow: pipeline → context → action hints → plan',
    type: KnowledgeType.Workflow,
    priority: KnowledgePriority.High,
    tags: ['agent', 'workflow'],
    appliesWhen: ['generate-code', 'refactor', 'fix-bug'],
    content: \`When starting a task, the agent should:
1. shrk task "<task>" or list_pipelines + get_pipeline_context
2. get_action_hints to see commands/forbidden actions
3. create_generation_plan for any code write
4. Ask the human to run shrk apply <plan>\`,
    actionHints: {
      mcpTools: ['get_task_packet', 'list_pipelines', 'get_action_hints'],
      commands: ['shrk task "<task>"'],
      preferredFlow: ['pipeline', 'context', 'action-hints', 'plan'],
      verificationCommands: ['shrk doctor'],
      writePolicy: 'cli-only',
    },
  })`,
    ],
    rules: [COMMON_SAFETY_RULE],
    pipelines: [COMMON_PIPELINE_CONTEXT_ONLY, COMMON_PIPELINE_FEATURE_DEV],
    docs: {
      'overview.md': OVERVIEW_DOC(
        'AI-agent-ready baseline',
        'Strong action hints, verification commands, no MCP writes. Pair this with another preset for paths/templates.',
      ),
    },
  },
  recommendedNextCommands: ['shrk doctor', 'shrk task "<task>"'],
});

const SAFE_CODEGEN: IPreset = definePreset({
  id: 'safe-codegen',
  title: 'Safe code generation',
  description: 'Generation safety baseline: dry-run by default, signed plans, verify-after-apply.',
  tags: ['safety', 'generator'],
  weight: 6,
  includes: {
    knowledge: [COMMON_AGENT_BRIEFING],
    rules: [
      COMMON_SAFETY_RULE,
      `defineKnowledgeEntry({
    id: 'generation.sign-plans',
    title: 'Sign generation plans for the apply path',
    type: KnowledgeType.Rule,
    priority: KnowledgePriority.High,
    tags: ['safety', 'signing'],
    appliesWhen: ['generate-code'],
    content: 'For shared/CI flows, sign plans with --sign and verify with --verify-signature on apply.',
    actionHints: {
      commands: [
        { command: 'shrk gen <id> <name> --dry-run --sign --save-plan <file>' },
        { command: 'shrk apply <file> --verify-signature' },
      ],
      verificationCommands: ['shrk doctor'],
      writePolicy: 'cli-only',
    },
  })`,
    ],
    pipelines: [COMMON_PIPELINE_FEATURE_DEV],
    docs: {
      'overview.md': OVERVIEW_DOC('Safe codegen', 'Plan-first generation with signed plans.'),
    },
  },
  recommendedNextCommands: [
    'shrk doctor',
    'shrk gen <template> <name> --dry-run --sign --save-plan plan.json',
  ],
});

const TESTING_FOCUSED: IPreset = definePreset({
  id: 'testing-focused',
  title: 'Testing-focused setup',
  description: 'Unit / integration / mutation testing guidance, test path conventions, test templates, dedicated test pipeline.',
  tags: ['testing'],
  weight: 5,
  includes: {
    knowledge: [COMMON_AGENT_BRIEFING],
    rules: [
      COMMON_SAFETY_RULE,
      `defineKnowledgeEntry({
    id: 'testing.target-services',
    title: 'Test services, not routes',
    type: KnowledgeType.Rule,
    priority: KnowledgePriority.High,
    tags: ['testing'],
    appliesWhen: ['generate-test'],
    content: 'Unit tests target services and utilities. HTTP routing is thin glue and does not need a dedicated test.',
  })`,
    ],
    paths: [COMMON_PATH_TESTS],
    templates: [COMMON_TEMPLATE_TEST],
    pipelines: [
      COMMON_PIPELINE_UNIT_TEST,
      `definePipeline({
    id: 'integration-test',
    title: 'Integration tests (optional)',
    description: 'Spin up real dependencies and run integration tests.',
    tags: ['test', 'integration'],
    steps: [
      {
        id: 'integration',
        type: 'command',
        description: 'Run integration suite.',
        cliCommands: ['bun test tests/integration'],
        required: false,
      },
    ],
  })`,
    ],
    docs: {
      'overview.md': OVERVIEW_DOC('Testing-focused', 'Unit-test target services. Mirror src/ under tests/.'),
    },
  },
  recommendedNextCommands: ['shrk doctor', 'shrk gen typescript.unit-test <subject> --dry-run'],
});

// ─── Polyglot presets ────────────────────────────────────────────────────
// These presets are language-specific. They do not depend on `WorkspaceProfile`
// (which is JS/TS-centric); they are listed and selectable via tags. Each
// captures the smallest sensible set of rules / paths / pipelines for the
// language and points the agent at the right verification commands.

const POLYGLOT_RECOMMENDED_NEXT = [
  'shrk doctor',
  'shrk languages detect',
  'shrk languages commands',
];

const JAVA_MAVEN_SERVICE: IPreset = definePreset({
  id: 'java-maven-service',
  title: 'Java Maven service',
  description: 'Baseline SharkCraft setup for a Java service built with Maven. Verifies via `mvn test`.',
  tags: ['java', 'maven', 'service', 'polyglot'],
  weight: 6,
  includes: {
    knowledge: [COMMON_AGENT_BRIEFING],
    rules: [COMMON_SAFETY_RULE],
    paths: [JAVA_MAVEN_PATH_MAIN, JAVA_MAVEN_PATH_TESTS],
    templates: [],
    pipelines: [],
    docs: {
      'overview.md': OVERVIEW_DOC(
        'Java Maven service',
        'Conventional `src/main/java` + `src/test/java`. Run `mvn test` before merging.',
      ),
    },
  },
  recommendedNextCommands: [...POLYGLOT_RECOMMENDED_NEXT, 'mvn test'],
});

const JAVA_GRADLE_SERVICE: IPreset = definePreset({
  id: 'java-gradle-service',
  title: 'Java Gradle service',
  description: 'Baseline for a Java service built with Gradle. Verifies via `./gradlew test`.',
  tags: ['java', 'gradle', 'service', 'polyglot'],
  weight: 6,
  includes: {
    knowledge: [COMMON_AGENT_BRIEFING],
    rules: [COMMON_SAFETY_RULE],
    paths: [JAVA_MAVEN_PATH_MAIN, JAVA_MAVEN_PATH_TESTS],
    templates: [],
    pipelines: [],
    docs: {
      'overview.md': OVERVIEW_DOC(
        'Java Gradle service',
        'Gradle wrapper (`./gradlew`) drives verification. Run `./gradlew test` before merging.',
      ),
    },
  },
  recommendedNextCommands: [...POLYGLOT_RECOMMENDED_NEXT, './gradlew test'],
});

const CSHARP_DOTNET_SERVICE: IPreset = definePreset({
  id: 'csharp-dotnet-service',
  title: 'C# / .NET service',
  description: 'Baseline for a .NET service. Verifies via `dotnet test`.',
  tags: ['csharp', 'dotnet', 'service', 'polyglot'],
  weight: 6,
  includes: {
    knowledge: [COMMON_AGENT_BRIEFING],
    rules: [COMMON_SAFETY_RULE],
    paths: [],
    templates: [],
    pipelines: [],
    docs: {
      'overview.md': OVERVIEW_DOC(
        'C# / .NET service',
        '`dotnet restore && dotnet build && dotnet test` is the canonical verification trio.',
      ),
    },
  },
  recommendedNextCommands: [...POLYGLOT_RECOMMENDED_NEXT, 'dotnet test'],
});

const PYTHON_SERVICE: IPreset = definePreset({
  id: 'python-service',
  title: 'Python service',
  description: 'Baseline for a Python service. Verifies via `pytest`; `ruff` + `mypy` are recommended.',
  tags: ['python', 'service', 'polyglot'],
  weight: 6,
  includes: {
    knowledge: [COMMON_AGENT_BRIEFING],
    rules: [COMMON_SAFETY_RULE],
    paths: [PYTHON_PATH_SRC, PYTHON_PATH_TESTS],
    templates: [],
    pipelines: [],
    docs: {
      'overview.md': OVERVIEW_DOC(
        'Python service',
        'Source under `src/`, tests under `tests/`. `pytest` is the verification command.',
      ),
    },
  },
  recommendedNextCommands: [...POLYGLOT_RECOMMENDED_NEXT, 'pytest'],
});

const GO_MODULE: IPreset = definePreset({
  id: 'go-module',
  title: 'Go module',
  description: 'Baseline for a Go module. Verifies via `go test ./...` and `go vet ./...`.',
  tags: ['go', 'golang', 'polyglot'],
  weight: 6,
  includes: {
    knowledge: [COMMON_AGENT_BRIEFING],
    rules: [COMMON_SAFETY_RULE],
    paths: [GO_PATH_CMD, GO_PATH_PKG, GO_PATH_INTERNAL],
    templates: [],
    pipelines: [],
    docs: {
      'overview.md': OVERVIEW_DOC(
        'Go module',
        '`cmd/`, `pkg/`, `internal/` layout. `go test ./...` and `go vet ./...` are the gates.',
      ),
    },
  },
  recommendedNextCommands: [...POLYGLOT_RECOMMENDED_NEXT, 'go test ./...'],
});

const RUST_CRATE: IPreset = definePreset({
  id: 'rust-crate',
  title: 'Rust crate',
  description: 'Baseline for a Rust crate. Verifies via `cargo test`, `cargo clippy`, `cargo fmt --check`.',
  tags: ['rust', 'cargo', 'polyglot'],
  weight: 6,
  includes: {
    knowledge: [COMMON_AGENT_BRIEFING],
    rules: [COMMON_SAFETY_RULE],
    paths: [RUST_PATH_SRC, RUST_PATH_TESTS],
    templates: [],
    pipelines: [],
    docs: {
      'overview.md': OVERVIEW_DOC(
        'Rust crate',
        '`src/lib.rs` or `src/main.rs`; integration tests under `tests/`. `cargo test` + `cargo clippy` are the gates.',
      ),
    },
  },
  recommendedNextCommands: [...POLYGLOT_RECOMMENDED_NEXT, 'cargo test'],
});

const POLYGLOT_MONOREPO: IPreset = definePreset({
  id: 'polyglot-monorepo',
  title: 'Polyglot monorepo',
  description:
    'Baseline for a repository with multiple language profiles (any of Java / C# / Python / Go / Rust + TS).',
  tags: ['polyglot', 'monorepo'],
  weight: 4,
  includes: {
    knowledge: [COMMON_AGENT_BRIEFING],
    rules: [COMMON_SAFETY_RULE],
    paths: [],
    templates: [],
    pipelines: [],
    docs: {
      'overview.md': OVERVIEW_DOC(
        'Polyglot monorepo',
        'Each language has its own verification commands; run `shrk languages commands` to see them.',
      ),
    },
  },
  recommendedNextCommands: [...POLYGLOT_RECOMMENDED_NEXT],
});

export const BUILTIN_PRESETS: readonly IPreset[] = Object.freeze([
  GENERIC,
  TYPESCRIPT_LIBRARY,
  BUN_SERVICE,
  NODE_API,
  FRONTEND_APP,
  ANGULAR_APP,
  NX_MONOREPO,
  MCP_SERVER_PRESET,
  AI_AGENT_READY,
  SAFE_CODEGEN,
  TESTING_FOCUSED,
  // Polyglot
  JAVA_MAVEN_SERVICE,
  JAVA_GRADLE_SERVICE,
  CSHARP_DOTNET_SERVICE,
  PYTHON_SERVICE,
  GO_MODULE,
  RUST_CRATE,
  POLYGLOT_MONOREPO,
  // Modern Angular, strict TypeScript, frontend/backend/testing variants
  ...MULTI_STACK_PRESETS,
  // Universal adoption: next-app, turborepo, package-workspace, clean-architecture-ts
  ...UNIVERSAL_ADOPTION_PRESETS,
  // Universal adoption top-5: nest-service, angular-app canonical aliases
  ...CANONICAL_ALIAS_PRESETS,
  // Angular 18 / 19 / 20 / 21 — signal queries, signal I/O, zoneless,
  // @if/@for/@defer/@let, resource() / httpResource(), inject(), no
  // NgModules. Weight 11-12 so the recommender prefers these over
  // R26 `modern-angular` (weight 9) when the workspace is Angular.
  ...ANGULAR_21_PRESETS,
  // NestJS 11+ — thin controllers, global ValidationPipe + class-validator,
  // async lifecycle, Fastify + cache + throttler, helmet + JWT guards,
  // structured logging + terminus health, TestingModule + supertest e2e.
  // Weight 11-12 so the recommender prefers these over R26 `nestjs-service`
  // (weight 7) and R47 `nest-service` (weight 9) when the workspace is Nest.
  ...NEST_11_PRESETS,
  // React 19+ — function components + ref-as-prop, hooks discipline,
  // Actions / useActionState / useOptimistic, TanStack Query for server
  // state, React Compiler + lazy + virtualization, useTransition /
  // Suspense, Vitest + RTL + userEvent + MSW, RSC + 'use client' +
  // Server Actions. Weight 11-12 so the recommender prefers these over
  // the legacy `frontend-app` (weight 6) when the workspace is React.
  ...REACT_19_PRESETS,
]);
