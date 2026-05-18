import { definePathConvention } from '@shrkcrft/paths';
import { KnowledgePriority } from '@shrkcrft/knowledge';

export const services = definePathConvention({
  id: 'app.services',
  title: 'Application services',
  path: 'src/services',
  description: 'All business-logic services live here. One service per file.',
  priority: KnowledgePriority.High,
  scope: ['typescript', 'backend'],
  tags: ['service'],
  appliesWhen: ['generate-service', 'create-business-logic'],
});

export const utils = definePathConvention({
  id: 'app.utils',
  title: 'Pure utilities',
  path: 'src/utils',
  description: 'Pure functions, no side effects.',
  priority: KnowledgePriority.Medium,
  scope: ['typescript'],
  tags: ['util'],
  appliesWhen: ['generate-utility'],
});

export const storage = definePathConvention({
  id: 'app.storage',
  title: 'Storage / persistence adapters',
  path: 'src/storage',
  description: 'Persistence adapters (DB, file, memory). Implementations of repository interfaces.',
  priority: KnowledgePriority.High,
  scope: ['typescript', 'backend'],
  tags: ['storage'],
  appliesWhen: ['add-persistence'],
});

export const observability = definePathConvention({
  id: 'app.observability',
  title: 'Observability',
  path: 'src/observability',
  description: 'Project logger, tracing helpers, metric counters.',
  priority: KnowledgePriority.Medium,
  scope: ['typescript', 'backend'],
  tags: ['observability'],
  appliesWhen: ['add-logging'],
});

export const tests = definePathConvention({
  id: 'app.tests',
  title: 'Test files',
  path: 'tests',
  description: '*.spec.ts files. Mirrors src/ layout for discoverability.',
  priority: KnowledgePriority.Medium,
  scope: ['testing'],
  tags: ['test'],
  appliesWhen: ['generate-test'],
});

export const docs = definePathConvention({
  id: 'app.docs',
  title: 'Project docs',
  path: 'sharkcraft/docs',
  description: 'Long-form narrative docs. Optional human depth.',
  priority: KnowledgePriority.Low,
  scope: ['docs'],
  tags: ['docs'],
  appliesWhen: ['add-docs'],
});

export default [services, utils, storage, observability, tests, docs];
