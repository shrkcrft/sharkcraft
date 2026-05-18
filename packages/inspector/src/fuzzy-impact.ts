/**
 * Fuzzy impact resolution.
 *
 * Wraps the query resolver so `shrk impact <query>` can accept any
 * free-form identifier (construct id, plugin key, symbol name, knowledge
 * id, template id, helper id, playbook id, command id, package name).
 *
 * Resolution converts the best match into a concrete impact input:
 *   file        → push the file
 *   construct   → push the construct's files
 *   symbol      → push files where the symbol is defined (via construct
 *                 files + heuristic text scan)
 *   plugin key  → push the matching construct's files
 *   event/DI    → push files of the construct that declares the facet
 *   template    → emit the template's target path as a suggested file
 *   helper      → emit the helper's suggested files where present
 *   playbook    → emit related files (file targets in the playbook)
 *   knowledge   → emit `references[]` of kind `file` from the entry
 *   command     → no impact target; return a next-command hint
 *   package     → no impact target by default; surface as a hint
 *
 * Read-only. No writes. No network.
 *
 * Schema: sharkcraft.fuzzy-impact-resolution/v1
 */
import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  QueryMatchKind,
  resolveQuery,
  type IQueryMatch,
  type IQueryResolution,
} from './query-resolver.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import { HELPERS } from './helper-registry.ts';

export const FUZZY_IMPACT_RESOLUTION_SCHEMA = 'sharkcraft.fuzzy-impact-resolution/v1';

export enum FuzzyImpactSourceKind {
  ExactFile = 'exact-file',
  Construct = 'construct',
  PluginKey = 'plugin-key',
  EventToken = 'event-token',
  DIToken = 'di-token',
  Symbol = 'symbol',
  Template = 'template',
  Helper = 'helper',
  Playbook = 'playbook',
  Knowledge = 'knowledge',
  Command = 'command',
  Package = 'package',
  Unresolved = 'unresolved',
}

export interface IFuzzyImpactResolution {
  schema: typeof FUZZY_IMPACT_RESOLUTION_SCHEMA;
  query: string;
  confidence: IQueryResolution['confidence'];
  source: FuzzyImpactSourceKind;
  /** Files derived from the resolved match (relative). May be empty. */
  files: readonly string[];
  /** Best match identifier (file path, construct id, etc.). */
  resolvedId?: string;
  /** Best match label for display. */
  resolvedLabel?: string;
  /** Alternatives the user may have intended. */
  alternatives: readonly IQueryMatch[];
  /** Whether the resolution is high enough confidence to auto-run impact. */
  shouldRunImpact: boolean;
  /** Recommended follow-up commands when impact does not auto-run. */
  followUpCommands: readonly string[];
  /** Diagnostics / explanations. */
  diagnostics: readonly string[];
  /** Match kind (taken from the underlying resolver match for traceability). */
  matchKind?: QueryMatchKind;
}

export interface IFuzzyImpactResolveOptions {
  /** Limit alternatives. Default 8. */
  limit?: number;
  /** Restrict resolver to a kind subset (e.g. only construct/plugin). */
  kinds?: readonly QueryMatchKind[];
  /** When true, do not auto-run impact even on exact match. */
  resolveOnly?: boolean;
}

interface IConstructLike {
  id: string;
  type: string;
  title?: string;
  files?: readonly string[];
  publicApi?: readonly string[];
  events?: readonly string[];
  tokens?: readonly string[];
  commands?: readonly string[];
  facets?: Record<string, readonly { id: string; value: string }[]>;
}

function listConstructsFrom(inspection: ISharkcraftInspection): readonly IConstructLike[] {
  // 1) Pre-warmed sync cache.
  const direct = (inspection as { constructs?: readonly IConstructLike[] }).constructs;
  if (direct && direct.length > 0) return direct;
  // 2) Registry with list() — duck-typed.
  const reg = (inspection as { constructRegistry?: { list?: () => readonly IConstructLike[] } })
    .constructRegistry;
  if (reg && typeof reg.list === 'function') {
    try {
      return reg.list();
    } catch {
      return [];
    }
  }
  return [];
}

function constructFor(
  inspection: ISharkcraftInspection,
  id: string,
): IConstructLike | undefined {
  return listConstructsFrom(inspection).find((c) => c.id === id);
}

function symbolToConstruct(
  inspection: ISharkcraftInspection,
  symbol: string,
): IConstructLike | undefined {
  const target = symbol.toLowerCase();
  for (const c of listConstructsFrom(inspection)) {
    for (const api of c.publicApi ?? []) {
      if (api.toLowerCase().includes(target)) return c;
    }
    for (const f of c.files ?? []) {
      const base = nodePath.basename(f, nodePath.extname(f)).toLowerCase();
      if (base === target) return c;
    }
  }
  return undefined;
}

function constructByFacet(
  inspection: ISharkcraftInspection,
  facetKind: 'event' | 'token' | 'plugin-key',
  value: string,
): IConstructLike | undefined {
  const target = value.toLowerCase();
  for (const c of listConstructsFrom(inspection)) {
    if (facetKind === 'event') {
      for (const e of c.events ?? []) {
        if (e.toLowerCase() === target || e.toLowerCase().endsWith('/' + target)) return c;
      }
    }
    if (facetKind === 'token') {
      for (const t of c.tokens ?? []) {
        if (t.toLowerCase() === target) return c;
      }
    }
    if (facetKind === 'plugin-key') {
      // Plugin keys typically appear in commands[] or tokens[] for plugin-shaped constructs.
      for (const cmd of c.commands ?? []) {
        if (cmd.toLowerCase().includes(target)) return c;
      }
      const facets = c.facets ?? {};
      for (const list of Object.values(facets)) {
        for (const v of list ?? []) {
          if (typeof v.value === 'string' && v.value.toLowerCase() === target) return c;
        }
      }
    }
  }
  return undefined;
}

function templateFilesFor(
  inspection: ISharkcraftInspection,
  templateId: string,
): readonly string[] {
  const tpl = inspection.templates.find((t) => t.id === templateId);
  if (!tpl) return [];
  const out: string[] = [];
  if (typeof tpl.targetPath === 'string') {
    out.push(tpl.targetPath);
  } else if (typeof tpl.targetPath === 'function') {
    // Best-effort: invoke with empty values to get a path with placeholders.
    try {
      const p = tpl.targetPath({} as never);
      if (typeof p === 'string') out.push(p);
    } catch {
      // ignore; we still emit follow-up commands for templates.
    }
  }
  return out;
}

function knowledgeFileReferences(
  inspection: ISharkcraftInspection,
  knowledgeId: string,
): readonly string[] {
  const k = inspection.knowledgeEntries.find((e) => e.id === knowledgeId) as
    | undefined
    | {
        references?: readonly { kind: string; path?: string }[];
      };
  if (!k) return [];
  const out: string[] = [];
  for (const ref of k.references ?? []) {
    if (ref.kind === 'file' && ref.path) out.push(ref.path);
  }
  return out;
}

function playbookFiles(
  inspection: ISharkcraftInspection,
  playbookId: string,
): readonly string[] {
  const reg = (inspection as {
    playbookRegistry?: { get?: (id: string) => unknown };
  }).playbookRegistry;
  if (!reg || typeof reg.get !== 'function') return [];
  const playbook = reg.get(playbookId) as
    | undefined
    | {
        steps?: readonly { template?: { targetPath?: string }; relatedFiles?: readonly string[] }[];
        relatedFiles?: readonly string[];
      };
  if (!playbook) return [];
  const out: string[] = [];
  for (const f of playbook.relatedFiles ?? []) out.push(f);
  for (const step of playbook.steps ?? []) {
    if (step.template?.targetPath) out.push(step.template.targetPath);
    for (const f of step.relatedFiles ?? []) out.push(f);
  }
  return out;
}

function helperFiles(helperId: string): readonly string[] {
  const helper = HELPERS.find((h) => h.id === helperId) as
    | { files?: readonly string[]; outputs?: readonly { path: string }[] }
    | undefined;
  if (!helper) return [];
  const out: string[] = [];
  for (const f of helper.files ?? []) out.push(f);
  for (const o of helper.outputs ?? []) out.push(o.path);
  return out;
}

function filesExist(projectRoot: string, files: readonly string[]): string[] {
  return files.filter((f) => existsSync(nodePath.join(projectRoot, f)));
}

function buildResolution(
  inspection: ISharkcraftInspection,
  query: string,
  resolution: IQueryResolution,
  opts: IFuzzyImpactResolveOptions,
): IFuzzyImpactResolution {
  const best = resolution.bestMatch;
  const limit = opts.limit ?? 8;
  const alternatives = resolution.alternatives.slice(0, limit);
  const followUps: string[] = [];
  const diagnostics: string[] = [];

  // No match.
  if (!best) {
    return {
      schema: FUZZY_IMPACT_RESOLUTION_SCHEMA,
      query,
      confidence: 'unknown',
      source: FuzzyImpactSourceKind.Unresolved,
      files: [],
      alternatives: [],
      shouldRunImpact: false,
      followUpCommands: [
        `shrk trace "${query}"`,
        `shrk search "${query}"`,
      ],
      diagnostics: [`No registry match for "${query}".`],
    };
  }

  // Exact file path (already verified to exist by the resolver).
  if (best.kind === QueryMatchKind.File) {
    return {
      schema: FUZZY_IMPACT_RESOLUTION_SCHEMA,
      query,
      confidence: resolution.confidence,
      source: FuzzyImpactSourceKind.ExactFile,
      files: [best.id],
      resolvedId: best.id,
      resolvedLabel: best.label,
      alternatives,
      shouldRunImpact: !opts.resolveOnly,
      followUpCommands: [],
      diagnostics: [],
      matchKind: best.kind,
    };
  }

  const auto = resolution.confidence === 'exact' || resolution.confidence === 'high';

  if (best.kind === QueryMatchKind.Construct) {
    const c = constructFor(inspection, best.id);
    const files = c?.files ? filesExist(inspection.projectRoot, c.files) : [];
    if (files.length === 0 && c) {
      diagnostics.push(
        `Construct "${best.id}" has no files[] entries or none exist on disk — running impact will be empty.`,
      );
    }
    followUps.push(`shrk constructs trace ${best.id} --deep`);
    if (files.length > 0) followUps.push(`shrk impact ${files[0]} --json`);
    return {
      schema: FUZZY_IMPACT_RESOLUTION_SCHEMA,
      query,
      confidence: resolution.confidence,
      source: FuzzyImpactSourceKind.Construct,
      files,
      resolvedId: best.id,
      resolvedLabel: best.label,
      alternatives,
      shouldRunImpact: !opts.resolveOnly && auto && files.length > 0,
      followUpCommands: followUps,
      diagnostics,
      matchKind: best.kind,
    };
  }

  if (best.kind === QueryMatchKind.Symbol || best.kind === QueryMatchKind.PluginKey) {
    let construct: IConstructLike | undefined;
    if (best.kind === QueryMatchKind.Symbol) {
      construct = symbolToConstruct(inspection, best.id);
    } else {
      construct = constructByFacet(inspection, 'plugin-key', best.id);
    }
    const files = construct?.files ? filesExist(inspection.projectRoot, construct.files) : [];
    if (!construct) {
      diagnostics.push(
        `Could not map ${best.kind} "${best.id}" back to a construct file set — try \`shrk constructs trace\`.`,
      );
      followUps.push(`shrk constructs trace ${best.id}`);
    }
    return {
      schema: FUZZY_IMPACT_RESOLUTION_SCHEMA,
      query,
      confidence: resolution.confidence,
      source:
        best.kind === QueryMatchKind.Symbol
          ? FuzzyImpactSourceKind.Symbol
          : FuzzyImpactSourceKind.PluginKey,
      files,
      resolvedId: best.id,
      resolvedLabel: best.label,
      alternatives,
      shouldRunImpact: !opts.resolveOnly && auto && files.length > 0,
      followUpCommands: followUps,
      diagnostics,
      matchKind: best.kind,
    };
  }

  if (best.kind === QueryMatchKind.EventToken || best.kind === QueryMatchKind.DIToken) {
    const construct = constructByFacet(
      inspection,
      best.kind === QueryMatchKind.EventToken ? 'event' : 'token',
      best.id,
    );
    const files = construct?.files ? filesExist(inspection.projectRoot, construct.files) : [];
    return {
      schema: FUZZY_IMPACT_RESOLUTION_SCHEMA,
      query,
      confidence: resolution.confidence,
      source:
        best.kind === QueryMatchKind.EventToken
          ? FuzzyImpactSourceKind.EventToken
          : FuzzyImpactSourceKind.DIToken,
      files,
      resolvedId: best.id,
      resolvedLabel: best.label,
      alternatives,
      shouldRunImpact: !opts.resolveOnly && auto && files.length > 0,
      followUpCommands: files.length === 0
        ? [`shrk constructs facets ${best.kind === QueryMatchKind.EventToken ? '--event' : '--token'} ${best.id}`]
        : [],
      diagnostics,
      matchKind: best.kind,
    };
  }

  if (best.kind === QueryMatchKind.Template) {
    const targetPaths = templateFilesFor(inspection, best.id);
    const present = filesExist(inspection.projectRoot, targetPaths);
    followUps.push(`shrk templates get ${best.id}`);
    followUps.push(`shrk templates preview ${best.id}`);
    if (present.length === 0 && targetPaths.length > 0) {
      diagnostics.push(
        `Template "${best.id}" target path does not exist yet — running impact on a non-existent file returns no dependents.`,
      );
    }
    return {
      schema: FUZZY_IMPACT_RESOLUTION_SCHEMA,
      query,
      confidence: resolution.confidence,
      source: FuzzyImpactSourceKind.Template,
      files: present,
      resolvedId: best.id,
      resolvedLabel: best.label,
      alternatives,
      shouldRunImpact: !opts.resolveOnly && auto && present.length > 0,
      followUpCommands: followUps,
      diagnostics,
      matchKind: best.kind,
    };
  }

  if (best.kind === QueryMatchKind.Helper) {
    const targets = helperFiles(best.id);
    const present = filesExist(inspection.projectRoot, targets);
    followUps.push(`shrk helper get ${best.id}`);
    followUps.push(`shrk helper plan ${best.id} --json`);
    return {
      schema: FUZZY_IMPACT_RESOLUTION_SCHEMA,
      query,
      confidence: resolution.confidence,
      source: FuzzyImpactSourceKind.Helper,
      files: present,
      resolvedId: best.id,
      resolvedLabel: best.label,
      alternatives,
      shouldRunImpact: !opts.resolveOnly && auto && present.length > 0,
      followUpCommands: followUps,
      diagnostics,
      matchKind: best.kind,
    };
  }

  if (best.kind === QueryMatchKind.Playbook) {
    const targets = playbookFiles(inspection, best.id);
    const present = filesExist(inspection.projectRoot, targets);
    followUps.push(`shrk playbooks get ${best.id}`);
    followUps.push(`shrk playbooks runbook ${best.id}`);
    return {
      schema: FUZZY_IMPACT_RESOLUTION_SCHEMA,
      query,
      confidence: resolution.confidence,
      source: FuzzyImpactSourceKind.Playbook,
      files: present,
      resolvedId: best.id,
      resolvedLabel: best.label,
      alternatives,
      shouldRunImpact: !opts.resolveOnly && auto && present.length > 0,
      followUpCommands: followUps,
      diagnostics,
      matchKind: best.kind,
    };
  }

  if (best.kind === QueryMatchKind.Knowledge) {
    const targets = knowledgeFileReferences(inspection, best.id);
    const present = filesExist(inspection.projectRoot, targets);
    followUps.push(`shrk knowledge get ${best.id}`);
    return {
      schema: FUZZY_IMPACT_RESOLUTION_SCHEMA,
      query,
      confidence: resolution.confidence,
      source: FuzzyImpactSourceKind.Knowledge,
      files: present,
      resolvedId: best.id,
      resolvedLabel: best.label,
      alternatives,
      shouldRunImpact: !opts.resolveOnly && auto && present.length > 0,
      followUpCommands: followUps,
      diagnostics:
        targets.length === 0
          ? [`Knowledge "${best.id}" has no file references — nothing to impact-analyse.`]
          : diagnostics,
      matchKind: best.kind,
    };
  }

  if (best.kind === QueryMatchKind.Command) {
    return {
      schema: FUZZY_IMPACT_RESOLUTION_SCHEMA,
      query,
      confidence: resolution.confidence,
      source: FuzzyImpactSourceKind.Command,
      files: [],
      resolvedId: best.id,
      resolvedLabel: best.label,
      alternatives,
      shouldRunImpact: false,
      followUpCommands: [`shrk commands get ${best.id}`, `shrk ${best.id} --help`],
      diagnostics: [
        `"${best.id}" resolves to a CLI command, not a code construct. Use \`shrk impact <file>\` to analyse files this command would touch.`,
      ],
      matchKind: best.kind,
    };
  }

  // Catch-all (policy, etc).
  return {
    schema: FUZZY_IMPACT_RESOLUTION_SCHEMA,
    query,
    confidence: resolution.confidence,
    source: FuzzyImpactSourceKind.Unresolved,
    files: [],
    resolvedId: best.id,
    resolvedLabel: best.label,
    alternatives,
    shouldRunImpact: false,
    followUpCommands: [`shrk trace "${query}" --deep`],
    diagnostics: [
      `"${query}" resolved to ${best.kind} — no direct impact target. Use the trace command for details.`,
    ],
    matchKind: best.kind,
  };
}

export function resolveFuzzyImpact(
  inspection: ISharkcraftInspection,
  query: string,
  options: IFuzzyImpactResolveOptions = {},
): IFuzzyImpactResolution {
  // Short-circuit: if the query is an existing file path, return ExactFile.
  if (query.includes('/') || query.includes('.')) {
    const abs = nodePath.isAbsolute(query) ? query : nodePath.join(inspection.projectRoot, query);
    if (existsSync(abs)) {
      const rel = nodePath.relative(inspection.projectRoot, abs) || query;
      return {
        schema: FUZZY_IMPACT_RESOLUTION_SCHEMA,
        query,
        confidence: 'exact',
        source: FuzzyImpactSourceKind.ExactFile,
        files: [rel],
        resolvedId: rel,
        resolvedLabel: rel,
        alternatives: [],
        shouldRunImpact: !options.resolveOnly,
        followUpCommands: [],
        diagnostics: [],
        matchKind: QueryMatchKind.File,
      };
    }
  }

  const resolveOpts: { limit?: number; kinds?: readonly QueryMatchKind[] } = {
    limit: options.limit ?? 8,
  };
  if (options.kinds && options.kinds.length > 0) {
    resolveOpts.kinds = options.kinds;
  }
  const resolution = resolveQuery(inspection, query, resolveOpts);
  return buildResolution(inspection, query, resolution, options);
}
