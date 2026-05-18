export interface IInitFile {
  relativePath: string;
  content: string;
}

export const INIT_FILES: readonly IInitFile[] = [
  {
    relativePath: 'sharkcraft.config.ts',
    content: `import { defineSharkCraftConfig } from '@shrkcrft/config';

export default defineSharkCraftConfig({
  projectName: 'my-project',
  description: 'A SharkCraft-powered repository.',
  knowledgeFiles: ['knowledge.ts'],
  ruleFiles: ['rules.ts'],
  pathFiles: ['paths.ts'],
  templateFiles: ['templates.ts'],
  docsFiles: ['docs/overview.md', 'docs/architecture.md', 'docs/quick-start.md'],
  defaultMaxTokens: 4000,
  defaultScope: ['typescript'],
});
`,
  },
  {
    relativePath: 'knowledge.ts',
    content: `import { defineKnowledgeEntry, KnowledgeType, KnowledgePriority } from '@shrkcrft/knowledge';

export const projectOverview = defineKnowledgeEntry({
  id: 'project.overview',
  title: 'Project Overview',
  type: KnowledgeType.Architecture,
  priority: KnowledgePriority.High,
  scope: ['typescript'],
  tags: ['overview', 'architecture'],
  appliesWhen: ['onboard', 'plan-work'],
  summary: 'High-level overview of this project.',
  content: \`This project is a TypeScript codebase. SharkCraft retrieves rules, path
conventions, templates and docs on demand instead of dumping everything.

Use \\\`shrk context --task "<task>"\\\` to retrieve only what matters for a task.\`,
});

export const aiAgentBriefing = defineKnowledgeEntry({
  id: 'agent.briefing',
  title: 'AI agent briefing',
  type: KnowledgeType.Convention,
  priority: KnowledgePriority.Critical,
  scope: ['ai-agent'],
  tags: ['agent', 'mcp', 'briefing'],
  appliesWhen: ['agent-start', 'agent-plan'],
  content: \`When working in this repo as an AI agent:
1. Call get_relevant_context with the current task — do not read every doc.
2. Use list_templates / get_template before generating files.
3. Use create_generation_plan (dry-run) before writing.
4. Respect path conventions and project rules.\`,
});

export const generationSafety = defineKnowledgeEntry({
  id: 'safety.generation',
  title: 'Generation safety',
  type: KnowledgeType.Warning,
  priority: KnowledgePriority.Critical,
  scope: ['generation'],
  tags: ['safety', 'generator'],
  appliesWhen: ['generate-code', 'overwrite-file'],
  content: \`Never write files without an explicit --write flag and a clean plan
(no conflicts). Never modify files outside the project root.\`,
});

export default [projectOverview, aiAgentBriefing, generationSafety];
`,
  },
  {
    relativePath: 'rules.ts',
    content: `import { defineRule } from '@shrkcrft/rules';
import { KnowledgePriority } from '@shrkcrft/knowledge';

export const tsNamingClasses = defineRule({
  id: 'typescript.naming.classes',
  title: 'TypeScript class naming',
  priority: KnowledgePriority.High,
  scope: ['typescript'],
  tags: ['typescript', 'naming', 'class'],
  appliesWhen: ['generate-code', 'review-code', 'create-service'],
  summary: 'Classes use PascalCase. Interfaces are prefixed with I.',
  content: \`Classes must use PascalCase. Abstract classes should use clear domain names.
Interfaces are prefixed with I (e.g. IUserService). Avoid vague names like Manager
unless it is truly an orchestrator.\`,
  examples: [
    { title: 'Good service name', code: 'export class UserProfileService {}', language: 'ts' },
    { title: 'Good interface name', code: 'export interface IUserService {}', language: 'ts' },
  ],
});

export const filesOneExport = defineRule({
  id: 'typescript.files.one-export',
  title: 'One top-level export per file',
  priority: KnowledgePriority.High,
  scope: ['typescript'],
  tags: ['typescript', 'files', 'organization'],
  appliesWhen: ['generate-code', 'create-feature'],
  content: \`Each file should export exactly one top-level construct (one class OR
one interface OR one enum OR one type). Helpers belong in their own files.\`,
});

export const noLogicInConstructor = defineRule({
  id: 'typescript.constructors.no-logic',
  title: 'No logic in constructors',
  priority: KnowledgePriority.High,
  scope: ['typescript', 'oop'],
  tags: ['typescript', 'lifecycle'],
  appliesWhen: ['create-service', 'create-class'],
  content: \`Constructors should only wire dependencies. Initialization belongs in
explicit lifecycle methods (init / initialize). This keeps classes test-friendly.\`,
});

export const generationDryRunByDefault = defineRule({
  id: 'generation.dry-run-by-default',
  title: 'Generation defaults to dry-run',
  priority: KnowledgePriority.Critical,
  scope: ['generation'],
  tags: ['safety', 'generator', 'agent'],
  appliesWhen: ['generate-code', 'agent-action'],
  content: \`shrk gen defaults to dry-run. A real write requires --write AND a plan
without conflicts. AI agents must call create_generation_plan first.\`,
});

export const preferAbsoluteImports = defineRule({
  id: 'typescript.imports.absolute',
  title: 'Prefer absolute imports across packages',
  priority: KnowledgePriority.Medium,
  scope: ['typescript'],
  tags: ['imports', 'typescript'],
  appliesWhen: ['generate-code', 'organize-imports'],
  content: \`Within a monorepo, prefer absolute imports via path aliases (e.g.
@scope/pkg) instead of long ../../../ chains across package boundaries.\`,
});

export default [
  tsNamingClasses,
  filesOneExport,
  noLogicInConstructor,
  generationDryRunByDefault,
  preferAbsoluteImports,
];
`,
  },
  {
    relativePath: 'paths.ts',
    content: `import { definePathConvention } from '@shrkcrft/paths';
import { KnowledgePriority } from '@shrkcrft/knowledge';

export const appSrc = definePathConvention({
  id: 'app.src',
  title: 'Application source root',
  path: 'src',
  description: 'All application source lives here.',
  priority: KnowledgePriority.Critical,
  scope: ['typescript'],
  tags: ['source-path', 'root'],
  appliesWhen: ['generate-code'],
});

export const services = definePathConvention({
  id: 'app.services',
  title: 'Application services',
  path: 'src/services',
  description: 'Application services live here.',
  priority: KnowledgePriority.High,
  scope: ['typescript', 'backend'],
  tags: ['service', 'source-path'],
  appliesWhen: ['generate-service', 'create-business-logic'],
});

export const utils = definePathConvention({
  id: 'app.utils',
  title: 'Utilities',
  path: 'src/utils',
  description: 'Pure functions, no side effects.',
  priority: KnowledgePriority.Medium,
  scope: ['typescript'],
  tags: ['util', 'source-path'],
  appliesWhen: ['generate-utility'],
});

export const features = definePathConvention({
  id: 'app.features',
  title: 'Feature folders',
  path: 'src/features',
  description: 'Vertical feature slices. Use this for end-to-end features.',
  priority: KnowledgePriority.Medium,
  scope: ['typescript'],
  tags: ['feature', 'source-path'],
  appliesWhen: ['generate-feature'],
});

export const tests = definePathConvention({
  id: 'app.tests',
  title: 'Test files',
  path: 'tests',
  description: 'Test files (or co-located *.spec.ts next to the unit under test).',
  priority: KnowledgePriority.Medium,
  scope: ['typescript', 'testing'],
  tags: ['test', 'source-path'],
  appliesWhen: ['generate-test'],
});

export const docs = definePathConvention({
  id: 'app.docs',
  title: 'Documentation',
  path: 'docs',
  description: 'Long-form human-readable docs (optional).',
  priority: KnowledgePriority.Low,
  scope: ['typescript'],
  tags: ['docs'],
  appliesWhen: ['add-docs'],
});

export default [appSrc, services, utils, features, tests, docs];
`,
  },
  {
    relativePath: 'templates.ts',
    content: `import { defineTemplate } from '@shrkcrft/templates';

export const tsService = defineTemplate({
  id: 'typescript.service',
  name: 'TypeScript Service',
  description: 'Creates a generic TypeScript service class.',
  tags: ['typescript', 'service'],
  scope: ['typescript'],
  appliesWhen: ['generate-service'],
  variables: [
    { name: 'name', required: true, description: 'kebab-case file name (e.g. user-profile)' },
    { name: 'className', required: true, description: 'PascalCase class name (e.g. UserProfileService)' },
  ],
  targetPath: ({ name }) => \`src/services/\${name}.service.ts\`,
  content: ({ className }) => \`export class \${className} {
  constructor() {}

  init(): void {
    // initialization logic
  }
}
\`,
  postGenerationNotes: ['Add tests if this service contains business logic.'],
  related: ['typescript.naming.classes', 'app.services'],
});

export const tsUtility = defineTemplate({
  id: 'typescript.utility',
  name: 'TypeScript Utility',
  description: 'Creates a pure utility module.',
  tags: ['typescript', 'utility'],
  scope: ['typescript'],
  appliesWhen: ['generate-utility'],
  variables: [
    { name: 'name', required: true, description: 'kebab-case file name' },
    { name: 'camel', required: true, description: 'camelCase function name' },
  ],
  targetPath: ({ name }) => \`src/utils/\${name}.ts\`,
  content: ({ camel }) => \`export function \${camel}(input: unknown): unknown {
  return input;
}
\`,
  postGenerationNotes: ['Keep utilities pure. No side effects, no shared mutable state.'],
});

export const tsFeatureFolder = defineTemplate({
  id: 'typescript.feature',
  name: 'TypeScript Feature folder',
  description: 'Creates a vertical feature slice (index + service + types).',
  tags: ['typescript', 'feature'],
  scope: ['typescript'],
  appliesWhen: ['generate-feature'],
  variables: [
    { name: 'name', required: true },
    { name: 'pascal', required: true },
  ],
  files: ({ name, pascal }) => [
    {
      targetPath: \`src/features/\${name}/index.ts\`,
      content: \`export * from './\${name}.service.ts';\nexport * from './\${name}.types.ts';\n\`,
    },
    {
      targetPath: \`src/features/\${name}/\${name}.service.ts\`,
      content: \`import type { I\${pascal}Config } from './\${name}.types.ts';\n\nexport class \${pascal}Service {\n  constructor(private readonly config: I\${pascal}Config) {}\n}\n\`,
    },
    {
      targetPath: \`src/features/\${name}/\${name}.types.ts\`,
      content: \`export interface I\${pascal}Config {\n  enabled: boolean;\n}\n\`,
    },
  ],
  postGenerationNotes: ['Add tests under tests/<feature> or co-located *.spec.ts.'],
});

export const tsTest = defineTemplate({
  id: 'typescript.test',
  name: 'TypeScript Test File',
  description: 'Creates a generic test file (Bun test format).',
  tags: ['typescript', 'test'],
  scope: ['typescript', 'testing'],
  appliesWhen: ['generate-test'],
  variables: [
    { name: 'name', required: true },
    { name: 'pascal', required: true },
  ],
  targetPath: ({ name }) => \`tests/\${name}.spec.ts\`,
  content: ({ pascal }) => \`import { describe, expect, test } from 'bun:test';\n\ndescribe('\${pascal}', () => {\n  test('placeholder', () => {\n    expect(true).toBe(true);\n  });\n});\n\`,
});

export default [tsService, tsUtility, tsFeatureFolder, tsTest];
`,
  },
  {
    relativePath: 'docs/overview.md',
    content: `# Project Overview

This is a SharkCraft-powered repository. Project knowledge lives under the local \`sharkcraft/\` folder as **structured TypeScript** plus optional markdown.

## Why structured knowledge?

- Rules, paths and templates are typed entries, not free-form prose.
- The CLI (\`shrk\`) and MCP server query them by id / tag / scope / appliesWhen.
- AI agents retrieve only what they need (\`shrk context --task ...\`) instead of reading every file.

## Quick commands

\`\`\`bash
shrk inspect
shrk knowledge list
shrk rules relevant --task "generate a TypeScript service"
shrk context --task "generate a TypeScript service" --max-tokens 3000
shrk templates list
shrk gen typescript.service user-profile --dry-run
shrk doctor
shrk mcp serve
\`\`\`
`,
  },
  {
    relativePath: 'docs/architecture.md',
    content: `# Architecture

This repository follows these conventions:

- Source under \`src/\`
- Services under \`src/services/\`
- Utilities under \`src/utils/\`
- Features under \`src/features/\`
- Tests under \`tests/\` (or co-located \`*.spec.ts\`)

Each rule and convention is encoded in \`sharkcraft/rules.ts\` and \`sharkcraft/paths.ts\`.

## Editing rules

Open \`sharkcraft/rules.ts\`, add a \`defineRule({...})\` export, and re-run \`shrk knowledge list\`.
`,
  },
  {
    relativePath: 'docs/quick-start.md',
    content: `# Quick start

1. **Inspect** the project:

   \`\`\`bash
   shrk inspect
   \`\`\`

2. **Retrieve context** for a task:

   \`\`\`bash
   shrk context --task "create a user profile service" --max-tokens 3000
   \`\`\`

3. **Generate** code (dry-run):

   \`\`\`bash
   shrk gen typescript.service user-profile --dry-run
   \`\`\`

4. **Write** when the plan is clean:

   \`\`\`bash
   shrk gen typescript.service user-profile --write
   \`\`\`

5. **Run the MCP server** for AI agents:

   \`\`\`bash
   shrk mcp serve
   \`\`\`
`,
  },
  {
    relativePath: 'tasks/roadmap.md',
    content: `# Roadmap

Use this file to list upcoming work. Each task can be referenced by AI agents via \`get_current_tasks\`.

## Now
- [ ] Encode initial project rules in \`sharkcraft/rules.ts\`
- [ ] Define path conventions in \`sharkcraft/paths.ts\`
- [ ] Define generator templates in \`sharkcraft/templates.ts\`

## Soon
- [ ] Add testing guidelines as knowledge entries
- [ ] Document architecture decisions
`,
  },
  {
    relativePath: 'tasks/backlog.md',
    content: `# Backlog

Lower-priority work for SharkCraft-powered knowledge in this repo.
`,
  },
];
