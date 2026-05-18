import { defineRule } from '@shrkcrft/rules';
import { KnowledgePriority } from '@shrkcrft/knowledge';

export const tsNamingClasses = defineRule({
  id: 'typescript.naming.classes',
  title: 'TypeScript class naming',
  priority: KnowledgePriority.High,
  scope: ['typescript'],
  tags: ['typescript', 'naming'],
  appliesWhen: ['generate-code', 'create-service', 'review-code'],
  summary: 'Classes use PascalCase. Interfaces are prefixed with I.',
  content: `Classes use PascalCase (e.g. UserService).
Interfaces are prefixed with I (e.g. IUser).
Avoid vague names like Manager; pick a name that describes the responsibility.`,
  examples: [
    { title: 'Service', code: 'export class UserService {}', language: 'ts' },
    { title: 'Interface', code: 'export interface IUser {}', language: 'ts' },
  ],
});

export const oneExportPerFile = defineRule({
  id: 'typescript.files.one-export',
  title: 'One exported construct per file',
  priority: KnowledgePriority.High,
  scope: ['typescript'],
  tags: ['typescript', 'organization'],
  appliesWhen: ['generate-code', 'create-feature'],
  content: `Each TypeScript file should export exactly one top-level construct.
Helpers live in their own file. Re-exports go in index.ts files.`,
});

export const noLogicInConstructors = defineRule({
  id: 'typescript.constructors.no-logic',
  title: 'No business logic in constructors',
  priority: KnowledgePriority.High,
  scope: ['typescript', 'oop'],
  tags: ['typescript', 'lifecycle'],
  appliesWhen: ['create-service'],
  content: `Constructors only wire dependencies. Initialization belongs in an
explicit init() method. This keeps services trivially testable.`,
});

export const httpRoutesThin = defineRule({
  id: 'http.routes.thin',
  title: 'HTTP routes stay thin',
  priority: KnowledgePriority.High,
  scope: ['backend'],
  tags: ['http', 'architecture'],
  appliesWhen: ['add-endpoint'],
  content: `Routes in src/server.ts only parse the request and call a service.
Business logic lives in src/services. Persistence lives in src/storage.
Routes never own database state.`,
});

export const validateInput = defineRule({
  id: 'http.validate-input',
  title: 'Validate request input at the route boundary',
  priority: KnowledgePriority.Critical,
  scope: ['backend', 'security'],
  tags: ['security', 'validation'],
  appliesWhen: ['add-endpoint', 'review-code'],
  content: `Treat all incoming request data as untrusted. Validate ids, query
strings, and bodies at the route. Reject early with 4xx; never pass raw input
to services.`,
});

export const testServicesNotRoutes = defineRule({
  id: 'testing.target-services',
  title: 'Test services, not routes',
  priority: KnowledgePriority.High,
  scope: ['testing'],
  tags: ['testing'],
  appliesWhen: ['generate-test'],
  content: `Unit tests target services and utilities. HTTP routing is thin
glue that doesn't need a dedicated test. Use bun test; no Jest, no Vitest.`,
});

export const noConsoleLog = defineRule({
  id: 'observability.no-console',
  title: 'Do not console.log in production code',
  priority: KnowledgePriority.Medium,
  scope: ['typescript'],
  tags: ['observability'],
  appliesWhen: ['review-code'],
  content: `Use the project logger (planned src/observability/logger.ts).
Direct console.log calls should be removed before merging.`,
});

export const dryRunGeneration = defineRule({
  id: 'generation.dry-run-by-default',
  title: 'shrk gen is dry-run by default',
  priority: KnowledgePriority.Critical,
  scope: ['generation'],
  tags: ['safety', 'generator'],
  appliesWhen: ['generate-code', 'agent-action'],
  content: `Always run shrk gen <id> <name> --dry-run first. Apply with --write
only after the plan is conflict-free. AI agents must call create_generation_plan
through MCP rather than writing files directly.`,
});

export default [
  tsNamingClasses,
  oneExportPerFile,
  noLogicInConstructors,
  httpRoutesThin,
  validateInput,
  testServicesNotRoutes,
  noConsoleLog,
  dryRunGeneration,
];
