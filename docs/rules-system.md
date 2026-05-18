# Rules system

A **rule** is a knowledge entry with `type=rule`. Rules carry coding/architecture/safety constraints.

## Defining a rule

```ts
import { defineRule } from '@shrkcrft/rules';
import { KnowledgePriority } from '@shrkcrft/knowledge';

export const rule = defineRule({
  id: 'typescript.naming.classes',
  title: 'Class naming',
  priority: KnowledgePriority.High,
  scope: ['typescript'],
  tags: ['typescript', 'naming'],
  appliesWhen: ['generate-code', 'create-service'],
  summary: 'Classes use PascalCase.',
  content: 'Classes must use PascalCase. ...',
  examples: [{ title: 'Good name', code: 'class UserProfileService {}', language: 'ts' }],
});
```

## Retrieval

```ts
const rules = ruleService.getRelevant('create a user profile service', { limit: 5 });
```

## CLI

```bash
shrk rules list
shrk rules get typescript.naming.classes
shrk rules relevant --task "create a user service" --limit 5
```

## MCP

- `list_rules`
- `get_rule`
- `get_relevant_rules`

Rules are **never dumped** unless the user explicitly requests it; the relevance-first design keeps token cost down.
