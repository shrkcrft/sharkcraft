export enum KnowledgeType {
  Rule = 'rule',
  Path = 'path',
  Template = 'template',
  Architecture = 'architecture',
  Technical = 'technical',
  Business = 'business',
  Command = 'command',
  Environment = 'environment',
  Dependency = 'dependency',
  Feature = 'feature',
  Task = 'task',
  Warning = 'warning',
  Decision = 'decision',
  Convention = 'convention',
  Workflow = 'workflow',
  Testing = 'testing',
  Security = 'security',
  Deployment = 'deployment',
  Integration = 'integration',
  Custom = 'custom',
}

export const ALL_KNOWLEDGE_TYPES: readonly KnowledgeType[] = Object.freeze(
  Object.values(KnowledgeType),
);

/**
 * Knowledge types that are purely descriptive (business context, decision
 * records) and legitimately have no actionable next step. Excluded from
 * action-hint coverage denominators so the target isn't artificially 100% — and
 * so an agent isn't pushed to bolt a hollow hint onto a pure-context entry just
 * to clear the gate.
 */
export const KNOWLEDGE_TYPES_NO_ACTION: ReadonlySet<KnowledgeType> = new Set([
  KnowledgeType.Business,
  KnowledgeType.Decision,
]);

export function isKnowledgeType(value: unknown): value is KnowledgeType {
  return typeof value === 'string' && ALL_KNOWLEDGE_TYPES.includes(value as KnowledgeType);
}
