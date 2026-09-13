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
  related?: string[];    // ids of related assets (any registered kind)
  seeAlso?: string[];    // ids a reader should also look at (any kind)
  supersededBy?: string[]; // knowledge ids that replace this entry — non-empty = superseded
  source?: { origin?: string; loader?: string };
  metadata?: Record<string, unknown>;
}
```

### Cross-references (round 11)

`related`, `seeAlso` and `supersededBy` are resolved — against every registry,
by the declared cross-reference collector — by `shrk self-config doctor` (and
`broken-links`, `resolve`, `xrefs`, `quality`). A dangling `related` / `seeAlso`
id is a warning; a dangling `supersededBy` is an error, as is a supersession
cycle. Load-time validation (`invalid-cross-reference`) checks only the shape: a
list of string ids, and an entry that does not supersede itself.

`shrk knowledge get <id>` renders them with the namespace each id resolved into
— `SUPERSEDED by: app.new (knowledge — "New way")  →  shrk knowledge get
app.new` directly under the id line, then `See also:` / `Related:` blocks — and
`--follow` renders the current entry after a superseded one. Markdown
frontmatter accepts `seeAlso:` / `see-also:` and `supersededBy:` /
`superseded-by:`. Prefer these fields over prose ("SUPERSEDED — see `x`"): prose
is never checked, so it points into a dead id the day `x` is renamed.

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
