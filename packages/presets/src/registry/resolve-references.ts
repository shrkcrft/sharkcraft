import type { IResolvedPreset } from './resolve-preset.ts';

/**
 * The minimal shape the reference-resolver needs from the inspection. This
 * lets the presets package stay independent of @shrkcrft/inspector at the
 * type level.
 */
export interface IReferenceLookup {
  hasKnowledge(id: string): boolean;
  hasRule(id: string): boolean;
  hasPath(id: string): boolean;
  hasTemplate(id: string): boolean;
  hasPipeline(id: string): boolean;
}

export interface IReferenceMissing {
  kind: 'knowledge' | 'rule' | 'path' | 'template' | 'pipeline';
  id: string;
}

export interface IResolvedReferences {
  knowledge: { resolved: string[]; missing: string[] };
  rules: { resolved: string[]; missing: string[] };
  paths: { resolved: string[]; missing: string[] };
  templates: { resolved: string[]; missing: string[] };
  pipelines: { resolved: string[]; missing: string[] };
  /** Flat list of every missing reference for convenience. */
  missing: readonly IReferenceMissing[];
  totalReferenced: number;
  totalMissing: number;
}

/**
 * Resolve the *Ids fields on a resolved preset against the inspection's
 * registries. Returns which references exist and which are missing.
 */
export function resolvePresetReferences(
  resolved: IResolvedPreset,
  lookup: IReferenceLookup,
): IResolvedReferences {
  const inc = resolved.includes;
  const out: IResolvedReferences = {
    knowledge: { resolved: [], missing: [] },
    rules: { resolved: [], missing: [] },
    paths: { resolved: [], missing: [] },
    templates: { resolved: [], missing: [] },
    pipelines: { resolved: [], missing: [] },
    missing: [],
    totalReferenced: 0,
    totalMissing: 0,
  };
  function check(
    ids: readonly string[] | undefined,
    bucket: { resolved: string[]; missing: string[] },
    kind: IReferenceMissing['kind'],
    has: (id: string) => boolean,
  ): void {
    if (!ids) return;
    for (const id of ids) {
      out.totalReferenced += 1;
      if (has(id)) {
        bucket.resolved.push(id);
      } else {
        bucket.missing.push(id);
        (out.missing as IReferenceMissing[]).push({ kind, id });
        out.totalMissing += 1;
      }
    }
  }
  check(inc.knowledgeIds, out.knowledge, 'knowledge', (id) => lookup.hasKnowledge(id));
  check(inc.ruleIds, out.rules, 'rule', (id) => lookup.hasRule(id));
  check(inc.pathConventionIds, out.paths, 'path', (id) => lookup.hasPath(id));
  check(inc.templateIds, out.templates, 'template', (id) => lookup.hasTemplate(id));
  check(inc.pipelineIds, out.pipelines, 'pipeline', (id) => lookup.hasPipeline(id));
  return out;
}
