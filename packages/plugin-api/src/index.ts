export * from './sharkcraft-plugin.ts';
export * from './command-plugin.ts';
export * from './knowledge-plugin.ts';
export * from './template-plugin.ts';
export * from './generator-plugin.ts';
export * from './ai-provider-plugin.ts';
export * from './mcp-tool-plugin.ts';
export * from './pack-manifest.ts';
export * from './pack-signing.ts';
export * from './delegate-recipe.ts';
export * from './scaffold-pattern.ts';
export * from './scaffold-strategy.ts';
// Authoring types for pack assets — TYPE-ONLY re-exports, erased at runtime, so
// a pack writing `import type { IKnowledgeEntry } from '@shrkcrft/plugin-api'`
// + `satisfies` gets kind/field checking at the definition site with no
// runtime coupling to a plugin-api version.
export type { IKnowledgeEntry, IKnowledgeReference, KnowledgeReferenceKind } from '@shrkcrft/knowledge';
export type { ITemplateDefinition, ITemplateChange } from '@shrkcrft/templates';
export * from './construct.ts';
export * from './playbook.ts';
export * from './policy-check.ts';
export * from './search-tuning.ts';
export * from './convention.ts';
export * from './convention-applies-to-filter.ts';
export * from './pack-helper.ts';
export * from './task-routing-hint.ts';
export * from './term-match-mode.ts';
export * from './registration-hint.ts';
export * from './framework-extractor-exports.ts';
export * from './framework-extractor-rejection-reasons.ts';
