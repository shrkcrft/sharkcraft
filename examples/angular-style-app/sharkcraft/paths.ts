import { definePathConvention } from '@shrkcrft/paths';
import { KnowledgePriority } from '@shrkcrft/knowledge';

export const components = definePathConvention({
  id: 'app.components',
  title: 'Angular components',
  path: 'src/app/components',
  description: 'Reusable Angular components.',
  priority: KnowledgePriority.High,
  scope: ['angular'],
  tags: ['component'],
  appliesWhen: ['generate-component'],
});

export const services = definePathConvention({
  id: 'app.services',
  title: 'Angular services',
  path: 'src/app/services',
  description: 'Application-wide Angular services.',
  priority: KnowledgePriority.High,
  scope: ['angular'],
  tags: ['service'],
  appliesWhen: ['generate-service'],
});

export default [components, services];
