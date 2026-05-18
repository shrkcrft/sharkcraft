export enum KnowledgePriority {
  Critical = 'critical',
  High = 'high',
  Medium = 'medium',
  Low = 'low',
}

export const PRIORITY_WEIGHTS: Readonly<Record<KnowledgePriority, number>> = Object.freeze({
  [KnowledgePriority.Critical]: 100,
  [KnowledgePriority.High]: 70,
  [KnowledgePriority.Medium]: 40,
  [KnowledgePriority.Low]: 10,
});

export function priorityWeight(priority: KnowledgePriority | undefined): number {
  return PRIORITY_WEIGHTS[priority ?? KnowledgePriority.Medium];
}
