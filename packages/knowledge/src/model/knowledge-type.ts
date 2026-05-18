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

export function isKnowledgeType(value: unknown): value is KnowledgeType {
  return typeof value === 'string' && ALL_KNOWLEDGE_TYPES.includes(value as KnowledgeType);
}
