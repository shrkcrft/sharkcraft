import { defineRule } from '@shrkcrft/rules';
import { KnowledgePriority } from '@shrkcrft/knowledge';

export const tsNamingClasses = defineRule({
  id: 'typescript.naming.classes',
  title: 'TypeScript class naming',
  priority: KnowledgePriority.High,
  scope: ['typescript'],
  tags: ['typescript', 'naming'],
  appliesWhen: ['generate-code', 'create-service'],
  summary: 'Classes use PascalCase. Interfaces are prefixed with I.',
  content: `Classes must use PascalCase. Interfaces are prefixed with I (e.g. IUserService).
Avoid vague names like Manager unless it is truly an orchestrator.`,
  examples: [{ title: 'Good service name', code: 'export class UserProfileService {}', language: 'ts' }],
});

export const filesOneExport = defineRule({
  id: 'typescript.files.one-export',
  title: 'One top-level export per file',
  priority: KnowledgePriority.High,
  scope: ['typescript'],
  tags: ['typescript', 'files'],
  appliesWhen: ['generate-code', 'create-feature'],
  content: `Each file should export exactly one top-level construct.`,
});

export const dryRunByDefault = defineRule({
  id: 'generation.dry-run-by-default',
  title: 'Generation defaults to dry-run',
  priority: KnowledgePriority.Critical,
  scope: ['generation'],
  tags: ['safety', 'generator'],
  appliesWhen: ['generate-code'],
  content: `shrk gen defaults to dry-run. A real write needs --write AND no conflicts.`,
});

export default [tsNamingClasses, filesOneExport, dryRunByDefault];
