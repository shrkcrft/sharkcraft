import { defineRule } from '@shrkcrft/rules';
import { KnowledgePriority } from '@shrkcrft/knowledge';

export const interfacesIPrefix = defineRule({
  id: 'angular.interfaces.i-prefix',
  title: 'Interfaces use I prefix',
  priority: KnowledgePriority.High,
  scope: ['angular', 'typescript'],
  tags: ['angular', 'naming'],
  appliesWhen: ['generate-code'],
  content: `All interfaces must use an I prefix (e.g. IUserService). Enums are preferred
over string union types for closed sets.`,
});

export default [interfacesIPrefix];
