# Knowledge system

## Entry shape

```ts
interface IKnowledgeEntry {
  id: string;            // unique, dot/dash-separated
  title: string;
  type: KnowledgeType;   // rule, path, template, architecture, technical, ...
  priority: 'critical' | 'high' | 'medium' | 'low';
  scope: string[];       // framework/area tags ('typescript', 'angular', 'backend')
  tags: string[];        // domain tags
  appliesWhen: string[]; // task hooks ('generate-service', 'review-code', ...)
  content: string;
  summary?: string;
  examples?: IKnowledgeExample[];
  related?: string[];    // ids of related entries
  source?: { origin?: string; loader?: string };
  metadata?: Record<string, unknown>;
}
```

## Defining entries

```ts
import { defineKnowledgeEntry, KnowledgeType, KnowledgePriority } from '@shrkcrft/knowledge';

export const rule = defineKnowledgeEntry({
  id: 'typescript.naming.classes',
  title: 'Class naming',
  type: KnowledgeType.Rule,
  priority: KnowledgePriority.High,
  scope: ['typescript'],
  tags: ['typescript', 'naming'],
  appliesWhen: ['generate-code', 'review-code'],
  content: 'Classes use PascalCase. Interfaces are prefixed with I.',
});
```

## Loaders

Two built-in loaders:

- `TypeScriptKnowledgeLoader` — imports TS modules and harvests any exported value that looks like an `IKnowledgeEntry`. Also walks arrays and `{ entries: [...] }` shapes.
- `MarkdownKnowledgeLoader` — turns each `.md` file into one entry. Frontmatter (id, title, type, priority, scope, tags, appliesWhen) overrides defaults.

## Index + search

The `KnowledgeIndex` indexes by id and supports:

- Free-text query (id, title, summary, content)
- Tag, scope, `appliesWhen`, priority filters
- Per-word match across tags, scope, appliesWhen

`scoreEntry` returns the score plus a list of `IKnowledgeMatchReason`s for traceability.

## Helpers

- `defineRule(...)` — wraps `defineKnowledgeEntry` with `type=rule`.
- `definePathConvention(...)` — wraps with `type=path` and stores the actual path in metadata.
- `defineTemplate(...)` — separate template registry (not in the knowledge index by default).
