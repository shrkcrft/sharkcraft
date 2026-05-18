# Path system

A **path convention** is a knowledge entry with `type=path` that stores the canonical path in `metadata.path`.

## Defining

```ts
import { definePathConvention } from '@shrkcrft/paths';
import { KnowledgePriority } from '@shrkcrft/knowledge';

export const services = definePathConvention({
  id: 'app.services',
  title: 'Application services',
  path: 'src/services',
  description: 'All app services live here.',
  priority: KnowledgePriority.High,
  scope: ['typescript', 'backend'],
  tags: ['service'],
  appliesWhen: ['generate-service'],
});
```

## Retrieval

```ts
const best = pathService.findBestForTask('create a user service');
// → { convention, reason: 'tag match, appliesWhen match', score: 70 }
```

## CLI

```bash
shrk paths list
shrk paths get app.services
shrk paths search service
shrk paths best --task "generate a user service"
```

## MCP

- `list_path_conventions`
- `get_path_convention`
- `search_path_conventions`
- `explain_generation_target` (combines template + best path)
