import type { IReferenceLookup } from '@shrkcrft/presets';
import { referenceIdsFor, type ReferenceKind } from './reference-registry.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

/**
 * Adapt a SharkCraft inspection to the {@link IReferenceLookup} contract the
 * preset reference resolver expects. Pure read-through; no state.
 *
 * A projection of THE reference registry, never a second id authority: it
 * used to build its template / pipeline sets from `inspection.templates` /
 * `inspection.pipelines` rather than the registries `templates list` and
 * `pipelines list` read — two answers to "does this id exist?" that agreed
 * only while nobody filtered one of them.
 */
export function inspectionReferenceLookup(
  inspection: ISharkcraftInspection,
): IReferenceLookup {
  const ids = (kind: ReferenceKind): ReadonlySet<string> => new Set(referenceIdsFor(inspection, kind));
  const knowledgeIds = ids('knowledge');
  const ruleIds = ids('rule');
  const pathIds = ids('path-convention');
  const templateIds = ids('template');
  const pipelineIds = ids('pipeline');
  return {
    hasKnowledge: (id) => knowledgeIds.has(id),
    hasRule: (id) => ruleIds.has(id),
    hasPath: (id) => pathIds.has(id),
    hasTemplate: (id) => templateIds.has(id),
    hasPipeline: (id) => pipelineIds.has(id),
  };
}
