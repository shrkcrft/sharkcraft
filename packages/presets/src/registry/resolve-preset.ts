import type { IPreset, IPresetFile, IPresetIncludes } from '../model/preset.ts';
import type { PresetRegistry } from './preset-registry.ts';

export interface IResolvedPresetIssue {
  severity: 'error' | 'warning';
  code:
    | 'composition-cycle'
    | 'composed-not-found'
    | 'invalid-self-compose';
  message: string;
  presetId: string;
}

export interface IProvenanceEntry {
  /** The id of the preset that contributed this item. */
  presetId: string;
  /** Path through the composition graph: root → … → contributor. */
  chain: readonly string[];
}

/**
 * A flattened preset with composition resolved. Arrays are merged, deduped,
 * and provenance is recorded so callers can show "this entry came from
 * preset X via composition through Y".
 */
export interface IResolvedPreset {
  /** The root preset id that was requested. */
  rootId: string;
  /** Every preset id visited, in resolution order (root first, deepest last). */
  composedFrom: readonly string[];
  /** Final merged metadata (title/description/tags/etc. come from the root). */
  preset: IPreset;
  /** Merged includes block; arrays deduplicated. */
  includes: IPresetIncludes & {
    knowledgeIds?: readonly string[];
    ruleIds?: readonly string[];
    pathConventionIds?: readonly string[];
    templateIds?: readonly string[];
    pipelineIds?: readonly string[];
    knowledge?: readonly string[];
    rules?: readonly string[];
    paths?: readonly string[];
    templates?: readonly string[];
    pipelines?: readonly string[];
  };
  /** Files to create — local preset wins on path conflict. */
  filesToCreate: readonly IPresetFile[];
  /** Merged recommendedNextCommands (deduped, root order preserved). */
  recommendedNextCommands: readonly string[];
  /** Merged postInstallNotes. */
  postInstallNotes: readonly string[];
  /** Merged safetyNotes. */
  safetyNotes: readonly string[];
  /** Per-item provenance for arrays. */
  provenance: {
    knowledge: ReadonlyMap<string, IProvenanceEntry>;
    rules: ReadonlyMap<string, IProvenanceEntry>;
    paths: ReadonlyMap<string, IProvenanceEntry>;
    templates: ReadonlyMap<string, IProvenanceEntry>;
    pipelines: ReadonlyMap<string, IProvenanceEntry>;
    knowledgeIds: ReadonlyMap<string, IProvenanceEntry>;
    ruleIds: ReadonlyMap<string, IProvenanceEntry>;
    pathConventionIds: ReadonlyMap<string, IProvenanceEntry>;
    templateIds: ReadonlyMap<string, IProvenanceEntry>;
    pipelineIds: ReadonlyMap<string, IProvenanceEntry>;
    files: ReadonlyMap<string, IProvenanceEntry>;
  };
  issues: readonly IResolvedPresetIssue[];
}

/** Stable-key for a TS-source array item: the slug between `id:` and the next `,`. */
function snippetKey(snippet: string, fallback: string): string {
  const m = snippet.match(/id:\s*['"`]([^'"`]+)['"`]/);
  return m?.[1] ?? fallback;
}

function recordWithProvenance(
  items: readonly string[] | undefined,
  bucket: string[],
  prov: Map<string, IProvenanceEntry>,
  chain: readonly string[],
  presetId: string,
): void {
  if (!items) return;
  for (let i = 0; i < items.length; i += 1) {
    const value = items[i]!;
    const key = snippetKey(value, `${presetId}:${i}`);
    if (prov.has(key)) continue; // first contributor wins (root → composed depth-first)
    bucket.push(value);
    prov.set(key, { presetId, chain });
  }
}

function recordIds(
  items: readonly string[] | undefined,
  bucket: string[],
  prov: Map<string, IProvenanceEntry>,
  chain: readonly string[],
  presetId: string,
): void {
  if (!items) return;
  for (const id of items) {
    if (prov.has(id)) continue;
    bucket.push(id);
    prov.set(id, { presetId, chain });
  }
}

function recordKvMap(
  v: ReadonlyMap<string, string> | Readonly<Record<string, string>> | undefined,
  out: Map<string, string>,
): void {
  if (!v) return;
  const it = v instanceof Map ? v.entries() : Object.entries(v);
  for (const [k, val] of it) {
    if (out.has(k)) continue;
    out.set(k, val);
  }
}

/**
 * Resolve a preset by id, recursively expanding `composes`. Returns:
 *  - the merged preset shape (with provenance per array entry),
 *  - a list of issues (cycle, missing-composed, …).
 *
 * Resolution order: the **root** preset's local items come first, then each
 * composed preset's items are appended depth-first (post-order). "First
 * contributor wins" — so the root naturally overrides composed presets on
 * duplicate ids.
 */
export function resolvePreset(
  registry: PresetRegistry,
  rootId: string,
): IResolvedPreset {
  const root = registry.get(rootId);
  if (!root) {
    throw new Error(`Cannot resolve preset "${rootId}" — not found in registry.`);
  }
  const issues: IResolvedPresetIssue[] = [];
  const composedFrom: string[] = [];
  const visited = new Set<string>();

  // Accumulators.
  const knowledge: string[] = [];
  const rules: string[] = [];
  const paths: string[] = [];
  const templates: string[] = [];
  const pipelines: string[] = [];
  const knowledgeIds: string[] = [];
  const ruleIds: string[] = [];
  const pathConventionIds: string[] = [];
  const templateIds: string[] = [];
  const pipelineIds: string[] = [];
  const docsMap = new Map<string, string>();
  const tasksMap = new Map<string, string>();
  const filePaths = new Map<string, IPresetFile>();
  const provFiles = new Map<string, IProvenanceEntry>();
  const provKnowledge = new Map<string, IProvenanceEntry>();
  const provRules = new Map<string, IProvenanceEntry>();
  const provPaths = new Map<string, IProvenanceEntry>();
  const provTemplates = new Map<string, IProvenanceEntry>();
  const provPipelines = new Map<string, IProvenanceEntry>();
  const provKnowledgeIds = new Map<string, IProvenanceEntry>();
  const provRuleIds = new Map<string, IProvenanceEntry>();
  const provPathConventionIds = new Map<string, IProvenanceEntry>();
  const provTemplateIds = new Map<string, IProvenanceEntry>();
  const provPipelineIds = new Map<string, IProvenanceEntry>();
  const recommendedNextCommands: string[] = [];
  const seenCommands = new Set<string>();
  const postInstallNotes: string[] = [];
  const seenNotes = new Set<string>();
  const safetyNotes: string[] = [];
  const seenSafety = new Set<string>();

  function visit(presetId: string, chain: readonly string[]): void {
    // Cycle check FIRST — otherwise the visited-cache below would silently
    // swallow a back-edge cycle (e.g. a → b → a) and we'd never report it.
    if (chain.includes(presetId)) {
      issues.push({
        severity: 'error',
        code: 'composition-cycle',
        message: `Cycle detected: ${[...chain, presetId].join(' → ')}`,
        presetId,
      });
      return;
    }
    if (visited.has(presetId)) return;
    if (presetId === rootId && chain.length > 0) {
      issues.push({
        severity: 'error',
        code: 'invalid-self-compose',
        message: `Preset "${presetId}" composes itself`,
        presetId,
      });
      return;
    }
    const preset = registry.get(presetId);
    if (!preset) {
      issues.push({
        severity: 'error',
        code: 'composed-not-found',
        message: `Preset "${chain[chain.length - 1] ?? rootId}" composes unknown preset "${presetId}"`,
        presetId,
      });
      return;
    }
    visited.add(presetId);
    composedFrom.push(presetId);

    // First: visit composed presets so the root keeps "first contributor wins"
    // priority over composed entries. We do this by recording the ROOT's
    // contributions before recursing. Composed presets append after.
    const includes = preset.includes as Readonly<{
      knowledge?: readonly string[];
      rules?: readonly string[];
      paths?: readonly string[];
      templates?: readonly string[];
      pipelines?: readonly string[];
      knowledgeIds?: readonly string[];
      ruleIds?: readonly string[];
      pathConventionIds?: readonly string[];
      templateIds?: readonly string[];
      pipelineIds?: readonly string[];
      docs?: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
      tasks?: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
    }>;
    recordWithProvenance(includes.knowledge, knowledge, provKnowledge, chain, presetId);
    recordWithProvenance(includes.rules, rules, provRules, chain, presetId);
    recordWithProvenance(includes.paths, paths, provPaths, chain, presetId);
    recordWithProvenance(includes.templates, templates, provTemplates, chain, presetId);
    recordWithProvenance(includes.pipelines, pipelines, provPipelines, chain, presetId);
    recordIds(includes.knowledgeIds, knowledgeIds, provKnowledgeIds, chain, presetId);
    recordIds(includes.ruleIds, ruleIds, provRuleIds, chain, presetId);
    recordIds(
      includes.pathConventionIds,
      pathConventionIds,
      provPathConventionIds,
      chain,
      presetId,
    );
    recordIds(includes.templateIds, templateIds, provTemplateIds, chain, presetId);
    recordIds(includes.pipelineIds, pipelineIds, provPipelineIds, chain, presetId);
    recordKvMap(includes.docs, docsMap);
    recordKvMap(includes.tasks, tasksMap);
    for (const f of preset.filesToCreate ?? []) {
      if (!filePaths.has(f.path)) {
        filePaths.set(f.path, f);
        provFiles.set(f.path, { presetId, chain });
      }
    }
    for (const cmd of preset.recommendedNextCommands ?? []) {
      if (seenCommands.has(cmd)) continue;
      seenCommands.add(cmd);
      recommendedNextCommands.push(cmd);
    }
    for (const note of preset.postInstallNotes ?? []) {
      if (seenNotes.has(note)) continue;
      seenNotes.add(note);
      postInstallNotes.push(note);
    }
    for (const sn of preset.safetyNotes ?? []) {
      if (seenSafety.has(sn)) continue;
      seenSafety.add(sn);
      safetyNotes.push(sn);
    }

    // Recurse into composed presets.
    const nextChain = [...chain, presetId];
    for (const dep of preset.composes ?? []) {
      visit(dep, nextChain);
    }
  }

  visit(rootId, []);

  const resolvedIncludes: IResolvedPreset['includes'] = {
    ...(knowledge.length ? { knowledge } : {}),
    ...(rules.length ? { rules } : {}),
    ...(paths.length ? { paths } : {}),
    ...(templates.length ? { templates } : {}),
    ...(pipelines.length ? { pipelines } : {}),
    ...(knowledgeIds.length ? { knowledgeIds } : {}),
    ...(ruleIds.length ? { ruleIds } : {}),
    ...(pathConventionIds.length ? { pathConventionIds } : {}),
    ...(templateIds.length ? { templateIds } : {}),
    ...(pipelineIds.length ? { pipelineIds } : {}),
    ...(docsMap.size ? { docs: docsMap } : {}),
    ...(tasksMap.size ? { tasks: tasksMap } : {}),
  };

  return {
    rootId,
    composedFrom,
    preset: root,
    includes: resolvedIncludes,
    filesToCreate: [...filePaths.values()],
    recommendedNextCommands,
    postInstallNotes,
    safetyNotes,
    provenance: {
      knowledge: provKnowledge,
      rules: provRules,
      paths: provPaths,
      templates: provTemplates,
      pipelines: provPipelines,
      knowledgeIds: provKnowledgeIds,
      ruleIds: provRuleIds,
      pathConventionIds: provPathConventionIds,
      templateIds: provTemplateIds,
      pipelineIds: provPipelineIds,
      files: provFiles,
    },
    issues,
  };
}
