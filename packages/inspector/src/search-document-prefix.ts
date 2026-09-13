/**
 * Every `<prefix>` a search-document id (`<prefix>:<id>`) can carry — exactly
 * the prefixes `buildSearchIndex` emits. See `search-document-id.ts`, the one
 * codec for the format.
 */
export type SearchDocumentPrefix =
  | 'knowledge'
  | 'rule'
  | 'path'
  | 'template'
  | 'pipeline'
  | 'preset'
  | 'pack'
  | 'boundary'
  | 'bundle'
  | 'session'
  | 'construct'
  | 'facet'
  | 'playbook'
  | 'doc';
