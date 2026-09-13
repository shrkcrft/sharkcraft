/**
 * The pack manifest slots whose files the KNOWLEDGE loaders read — THE answer
 * to "is this contribution file knowledge?" (round 15 follow-up, F11).
 *
 * The inspection reads every file of these slots with the knowledge loaders (a
 * TypeScript / JavaScript module, or a Markdown document), and every other
 * slot's files with an importing loader. `packs test --load` used to decide
 * "Markdown knowledge" by the `.md` extension instead: a `.md` declared under
 * `templateFiles` was validated as if it were knowledge (while the consumer
 * imports it as a template module), and a knowledge-slot file no knowledge
 * loader reads passed in silence (while the consumer skips it as an
 * "unsupported contribution file"). The slot decides now; which knowledge loader
 * reads the file stays the runtime's own choice (`validateContributionFile`).
 */
export const KNOWLEDGE_CONTRIBUTION_SLOTS: readonly string[] = [
  'knowledgeFiles',
  'ruleFiles',
  'pathFiles',
  'pathConventionFiles',
  'docsFiles',
];

/** Does the manifest slot `slot` feed the knowledge loaders? */
export function isKnowledgeContributionSlot(slot: string): boolean {
  return KNOWLEDGE_CONTRIBUTION_SLOTS.includes(slot);
}
