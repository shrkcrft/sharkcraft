/**
 * SharkCraft constructs: a generic, project-agnostic system for modeling
 * "the thing this codebase calls X" — plugins, services, modules, features,
 * etc. A construct bundles together files, public API entries, events,
 * tokens, commands, and related knowledge / rules / templates so that
 * `shrk constructs trace <id>` can give a single coherent view.
 *
 * Constructs intentionally have no hardcoded "type" set. The `type` field is
 * a free string so packs can model their own domain (one project might
 * use 'plugin' / 'policy' / 'capability'; another might use 'service' /
 * 'module' / 'feature').
 */

export interface IConstructFacetValue {
  /** Stable id within the facet. */
  id: string;
  /** The actual value (e.g. event topic, token name). */
  value: string;
  description?: string;
  source?: string;
}

export interface IConstructInput {
  id: string;
  type: string;
  title: string;
  description?: string;
  tags?: readonly string[];
  /** Files belonging to the construct (relative to projectRoot). */
  files?: readonly string[];
  /** Public-API entries (re-exports, entrypoint files, named exports). */
  publicApi?: readonly string[];
  /** Stable event topics emitted / consumed by this construct. */
  events?: readonly string[];
  /** Stable token names (DI / capability / config keys). */
  tokens?: readonly string[];
  /** CLI / shell commands attached to the construct. */
  commands?: readonly string[];
  /** Knowledge ids related to this construct. */
  relatedKnowledge?: readonly string[];
  relatedRules?: readonly string[];
  relatedTemplates?: readonly string[];
  relatedPipelines?: readonly string[];
  relatedPathConventions?: readonly string[];
  /** Free-form facets keyed by name (e.g. capabilities, hooks, …). */
  facets?: Record<string, readonly IConstructFacetValue[]>;
}

export function defineConstruct(input: IConstructInput): IConstructInput {
  return input;
}

export interface IConstructFacetInput {
  id: string;
  constructId: string;
  /** Free-string kind: 'event' | 'token' | 'api' | 'file' | 'command' | … */
  kind: string;
  value: string;
  description?: string;
  source?: string;
}

export function defineConstructFacet(input: IConstructFacetInput): IConstructFacetInput {
  return input;
}
