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

// ─── Framework-specific path snippets ─────────────────────────────────────
//
// Each snippet uses the structured `metadata: { path: '<x>' }` field so
// the init paths-advisory annotator can verify the path against the live
// workspace. When an entry is emitted into a fresh repo whose layout
// doesn't match, the user sees a `⚠️ Workspace-shape advisory` block
// listing the absent paths.

// Nx workspaces — `libs/<area>/src/lib/<feature>.service.ts`,
// `apps/<app>/src/app/`. The exact lib/app folder names are
// project-specific; we point at the roots.
export const NX_PATH_LIBS = `defineKnowledgeEntry({
    id: 'paths.nx.libs',
    title: 'Nx libs root',
    type: KnowledgeType.Path,
    priority: KnowledgePriority.High,
    tags: ['paths', 'nx', 'libs'],
    scope: ['nx', 'monorepo'],
    appliesWhen: ['generate-service', 'generate-utility', 'create-feature'],
    content: 'Shared library code lives under libs/<area>/src/lib/. Each lib has a public index.ts; cross-lib imports go through the package name, never relative paths into src/.',
    metadata: { path: 'libs' },
  })`;

export const NX_PATH_APPS = `defineKnowledgeEntry({
    id: 'paths.nx.apps',
    title: 'Nx apps root',
    type: KnowledgeType.Path,
    priority: KnowledgePriority.High,
    tags: ['paths', 'nx', 'apps'],
    scope: ['nx', 'monorepo'],
    appliesWhen: ['create-feature', 'create-app'],
    content: 'Applications live under apps/<app>/. Frontends use apps/<app>/src/app/; backends use apps/<app>/src/. Keep app-specific code here and shared code in libs/.',
    metadata: { path: 'apps' },
  })`;

// Generic workspace monorepo (Turborepo, pnpm/yarn/npm workspaces): the
// idiomatic layout is `apps/` + `packages/` rather than Nx's `libs/`.
export const WORKSPACE_PATH_PACKAGES = `defineKnowledgeEntry({
    id: 'paths.workspace.packages',
    title: 'Workspace packages root',
    type: KnowledgeType.Path,
    priority: KnowledgePriority.High,
    tags: ['paths', 'workspaces', 'monorepo'],
    scope: ['monorepo', 'turborepo', 'workspaces'],
    appliesWhen: ['generate-code', 'create-feature'],
    content: 'Shared packages live under packages/<name>/. Each package exposes a stable public entry (package.json main/exports); cross-package imports go through the package name, never relative paths into src/.',
    metadata: { path: 'packages' },
  })`;

export const WORKSPACE_PATH_APPS = `defineKnowledgeEntry({
    id: 'paths.workspace.apps',
    title: 'Workspace apps root',
    type: KnowledgeType.Path,
    priority: KnowledgePriority.High,
    tags: ['paths', 'workspaces', 'monorepo'],
    scope: ['monorepo', 'turborepo', 'workspaces'],
    appliesWhen: ['create-feature', 'create-app'],
    content: 'Applications live under apps/<app>/. Each app has its own src/ root and depends on shared packages by name.',
    metadata: { path: 'apps' },
  })`;

// Single-app Angular workspaces — angular.json + src/app convention.
export const ANGULAR_PATH_APP = `defineKnowledgeEntry({
    id: 'paths.angular.app',
    title: 'Angular app root',
    type: KnowledgeType.Path,
    priority: KnowledgePriority.Critical,
    tags: ['paths', 'angular', 'app'],
    scope: ['angular'],
    appliesWhen: ['create-feature', 'generate-code'],
    content: 'Angular workspace source lives under src/app/. Components, services, pipes and modules sit under here. Tests are co-located as *.spec.ts beside the unit under test.',
    metadata: { path: 'src/app' },
  })`;

export const ANGULAR_PATH_COMPONENTS = `defineKnowledgeEntry({
    id: 'paths.angular.components',
    title: 'Angular components',
    type: KnowledgeType.Path,
    priority: KnowledgePriority.High,
    tags: ['paths', 'angular', 'components'],
    scope: ['angular'],
    appliesWhen: ['generate-component'],
    content: 'Components live under src/app/components/ or src/app/<feature>/. Use the .component.ts suffix. Pair each component with a co-located *.spec.ts test.',
    metadata: { path: 'src/app/components' },
  })`;

export const ANGULAR_PATH_SERVICES = `defineKnowledgeEntry({
    id: 'paths.angular.services',
    title: 'Angular services',
    type: KnowledgeType.Path,
    priority: KnowledgePriority.High,
    tags: ['paths', 'angular', 'services'],
    scope: ['angular'],
    appliesWhen: ['generate-service'],
    content: 'Injectable services live under src/app/services/ (or alongside their feature folder). Use the .service.ts suffix. Provide via providedIn root unless feature-scoped.',
    metadata: { path: 'src/app/services' },
  })`;

// React workspaces — many flavors (Vite SPA, Next.js, Remix). The
// snippets below cover the most common SPA layout (src/components,
// src/hooks, src/pages, src/lib). Frameworks that follow a different
// convention (e.g. Next.js app router under app/) will trigger the
// init paths-advisory; the user is expected to swap them at that point.

export const REACT_PATH_COMPONENTS = `defineKnowledgeEntry({
    id: 'paths.react.components',
    title: 'React components',
    type: KnowledgeType.Path,
    priority: KnowledgePriority.High,
    tags: ['paths', 'react', 'components'],
    scope: ['react'],
    appliesWhen: ['generate-component'],
    content: 'Components live under src/components/ (cross-feature shared) or under their feature folder. Keep each component in its own file; pair with a co-located *.test.tsx beside it.',
    metadata: { path: 'src/components' },
  })`;

export const REACT_PATH_HOOKS = `defineKnowledgeEntry({
    id: 'paths.react.hooks',
    title: 'React custom hooks',
    type: KnowledgeType.Path,
    priority: KnowledgePriority.High,
    tags: ['paths', 'react', 'hooks'],
    scope: ['react'],
    appliesWhen: ['generate-hook'],
    content: 'Custom hooks live under src/hooks/ (cross-feature) or under their feature folder. File and exported function are both named useX. Co-locate the test as useX.test.ts beside the hook.',
    metadata: { path: 'src/hooks' },
  })`;

export const REACT_PATH_PAGES = `defineKnowledgeEntry({
    id: 'paths.react.pages',
    title: 'React route / page components',
    type: KnowledgeType.Path,
    priority: KnowledgePriority.Medium,
    tags: ['paths', 'react', 'pages', 'routing'],
    scope: ['react'],
    appliesWhen: ['create-feature', 'add-route'],
    content: 'Top-level route components live under src/pages/ (React Router / TanStack Router convention) or under src/routes/. For Next.js app router, see src/app/<segment>/page.tsx instead — adjust this entry if your project uses that layout.',
    metadata: { path: 'src/pages' },
  })`;

export const REACT_PATH_LIB = `defineKnowledgeEntry({
    id: 'paths.react.lib',
    title: 'React app utilities + clients',
    type: KnowledgeType.Path,
    priority: KnowledgePriority.Medium,
    tags: ['paths', 'react', 'lib'],
    scope: ['react'],
    appliesWhen: ['generate-utility', 'generate-code'],
    content: 'Framework-agnostic helpers (formatters, validators, API clients) live under src/lib/. Keep them pure — no React imports unless the helper is a hook (in which case it belongs under src/hooks/).',
    metadata: { path: 'src/lib' },
  })`;

// NestJS services — module-per-folder convention; e2e tests in `test/`.
export const NEST_PATH_SRC = `defineKnowledgeEntry({
    id: 'paths.nest.src',
    title: 'Nest module roots',
    type: KnowledgeType.Path,
    priority: KnowledgePriority.Critical,
    tags: ['paths', 'nest', 'modules'],
    scope: ['nestjs'],
    appliesWhen: ['create-feature', 'generate-service', 'generate-code'],
    content: 'Nest source lives under src/. Each feature gets a folder src/<feature>/ containing controller, service, module, and DTOs (one construct per file). Controllers stay thin; business logic lives in services.',
    metadata: { path: 'src' },
  })`;

export const NEST_PATH_E2E = `defineKnowledgeEntry({
    id: 'paths.nest.e2e',
    title: 'Nest e2e tests',
    type: KnowledgeType.Path,
    priority: KnowledgePriority.Medium,
    tags: ['paths', 'nest', 'testing'],
    scope: ['nestjs'],
    appliesWhen: ['generate-test'],
    content: 'End-to-end tests live under test/ (Nest convention, not tests/). Unit tests can be co-located as *.spec.ts next to the unit.',
    metadata: { path: 'test' },
  })`;

// ─── Polyglot path snippets ──────────────────────────────────────────────

export const JAVA_MAVEN_PATH_MAIN = `defineKnowledgeEntry({
    id: 'paths.java.maven.main',
    title: 'Java Maven main source',
    type: KnowledgeType.Path,
    priority: KnowledgePriority.Critical,
    tags: ['paths', 'java', 'maven'],
    scope: ['java', 'maven'],
    appliesWhen: ['generate-code'],
    content: 'Main Java source lives under src/main/java/<package>/. Resources under src/main/resources/. Mirror tests under src/test/java/.',
    metadata: { path: 'src/main/java' },
  })`;

export const JAVA_MAVEN_PATH_TESTS = `defineKnowledgeEntry({
    id: 'paths.java.maven.tests',
    title: 'Java Maven tests',
    type: KnowledgeType.Path,
    priority: KnowledgePriority.High,
    tags: ['paths', 'java', 'maven', 'tests'],
    scope: ['java', 'maven'],
    appliesWhen: ['generate-test'],
    content: 'JUnit / Spring tests live under src/test/java/. Run via mvn test.',
    metadata: { path: 'src/test/java' },
  })`;

export const PYTHON_PATH_SRC = `defineKnowledgeEntry({
    id: 'paths.python.src',
    title: 'Python source root',
    type: KnowledgeType.Path,
    priority: KnowledgePriority.Critical,
    tags: ['paths', 'python'],
    scope: ['python'],
    appliesWhen: ['generate-code'],
    content: 'Source lives under src/<package>/ (PEP 517 src layout) or directly under <package>/ at the repo root. Pick one and stay consistent.',
    metadata: { path: 'src' },
  })`;

export const PYTHON_PATH_TESTS = `defineKnowledgeEntry({
    id: 'paths.python.tests',
    title: 'Python tests',
    type: KnowledgeType.Path,
    priority: KnowledgePriority.High,
    tags: ['paths', 'python', 'tests'],
    scope: ['python'],
    appliesWhen: ['generate-test'],
    content: 'Pytest tests live under tests/. Each test_*.py mirrors a module under src/.',
    metadata: { path: 'tests' },
  })`;

export const GO_PATH_CMD = `defineKnowledgeEntry({
    id: 'paths.go.cmd',
    title: 'Go entry points',
    type: KnowledgeType.Path,
    priority: KnowledgePriority.High,
    tags: ['paths', 'go'],
    scope: ['go'],
    appliesWhen: ['create-app'],
    content: 'Binary entry points live under cmd/<name>/main.go. Shared library code under pkg/ (public) or internal/ (module-private).',
    metadata: { path: 'cmd' },
  })`;

export const GO_PATH_PKG = `defineKnowledgeEntry({
    id: 'paths.go.pkg',
    title: 'Go shared packages',
    type: KnowledgeType.Path,
    priority: KnowledgePriority.Medium,
    tags: ['paths', 'go'],
    scope: ['go'],
    appliesWhen: ['generate-code'],
    content: 'Public packages live under pkg/<name>/. Tests are co-located as <name>_test.go. Run via go test ./...',
    metadata: { path: 'pkg' },
  })`;

export const GO_PATH_INTERNAL = `defineKnowledgeEntry({
    id: 'paths.go.internal',
    title: 'Go internal packages',
    type: KnowledgeType.Path,
    priority: KnowledgePriority.Medium,
    tags: ['paths', 'go'],
    scope: ['go'],
    appliesWhen: ['generate-code'],
    content: 'Module-private packages live under internal/<name>/. The Go compiler enforces that only the parent module can import these.',
    metadata: { path: 'internal' },
  })`;

export const RUST_PATH_SRC = `defineKnowledgeEntry({
    id: 'paths.rust.src',
    title: 'Rust crate source',
    type: KnowledgeType.Path,
    priority: KnowledgePriority.Critical,
    tags: ['paths', 'rust'],
    scope: ['rust'],
    appliesWhen: ['generate-code'],
    content: 'Crate source lives under src/. The entry point is src/lib.rs (library) or src/main.rs (binary). Modules nest as src/<mod>/mod.rs or src/<mod>.rs.',
    metadata: { path: 'src' },
  })`;

export const RUST_PATH_TESTS = `defineKnowledgeEntry({
    id: 'paths.rust.tests',
    title: 'Rust integration tests',
    type: KnowledgeType.Path,
    priority: KnowledgePriority.Medium,
    tags: ['paths', 'rust', 'tests'],
    scope: ['rust'],
    appliesWhen: ['generate-test'],
    content: 'Integration tests live under tests/<name>.rs. Unit tests live inline with #[cfg(test)] modules inside src/. Run via cargo test.',
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
