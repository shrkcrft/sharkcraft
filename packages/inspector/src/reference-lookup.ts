import type { IReferenceLookup } from '@shrkcrft/presets';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

/**
 * Adapt a SharkCraft inspection to the {@link IReferenceLookup} contract the
 * preset reference resolver expects. Pure read-through; no state.
 */
export function inspectionReferenceLookup(
  inspection: ISharkcraftInspection,
): IReferenceLookup {
  const knowledgeIds = new Set(inspection.knowledgeEntries.map((e) => e.id));
  const ruleIds = new Set(inspection.ruleService.list().map((r) => r.id));
  const pathIds = new Set(inspection.pathService.list().map((p) => p.id));
  const templateIds = new Set(inspection.templates.map((t) => t.id));
  const pipelineIds = new Set(inspection.pipelines.map((p) => p.id));
  return {
    hasKnowledge: (id) => knowledgeIds.has(id),
    hasRule: (id) => ruleIds.has(id),
    hasPath: (id) => pathIds.has(id),
    hasTemplate: (id) => templateIds.has(id),
    hasPipeline: (id) => pipelineIds.has(id),
  };
}
