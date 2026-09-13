/**
 * The shape of work a free-text query asks for — THE intent vocabulary
 * `classifyQueryIntent` answers in. The recommender gates source-writing
 * scaffolds on `Create`, pins grounding on `Plan`, and change-intent /
 * prepare-agent-task consult it instead of their own verb regexes.
 */
export enum QueryIntent {
  Create = 'create',
  Diagnose = 'diagnose',
  Repair = 'repair',
  Refactor = 'refactor',
  Review = 'review',
  Plan = 'plan',
  Explain = 'explain',
  Release = 'release',
  Unknown = 'unknown',
}
