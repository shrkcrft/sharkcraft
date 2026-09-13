/**
 * The format a knowledge entry was declared in — what its author edits to add
 * references (`references[]` in TypeScript, a `references:` frontmatter list in
 * Markdown). Carried on every stale-check `entryVerdicts[]` record
 * (`sourceFormat`) so a remedy names the right channel.
 */
export enum KnowledgeSourceFormat {
  TypeScript = 'typescript',
  Markdown = 'markdown',
  /** Neither file loader recorded it (a scaffolded or synthesized entry). */
  Other = 'other',
}
