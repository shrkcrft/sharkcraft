import { definePathConvention } from '@shrkcrft/paths';
import { KnowledgePriority } from '@shrkcrft/knowledge';

export const services = definePathConvention({
  id: 'app.services',
  title: 'Application services',
  path: 'src/services',
  description: 'All app services go here.',
  priority: KnowledgePriority.High,
  scope: ['typescript'],
  tags: ['service'],
  appliesWhen: ['generate-service'],
});

export const utils = definePathConvention({
  id: 'app.utils',
  title: 'Utilities',
  path: 'src/utils',
  description: 'Pure utilities.',
  priority: KnowledgePriority.Medium,
  scope: ['typescript'],
  tags: ['util'],
  appliesWhen: ['generate-utility'],
});

export default [services, utils];
