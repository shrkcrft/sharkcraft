import type { IEdge, INode } from '@shrkcrft/graph';

export const FRAMEWORK_SCHEMA = 'sharkcraft.framework/v1' as const;

export type FrameworkSchemaVersion = typeof FRAMEWORK_SCHEMA;

/**
 * Known framework tags. Open string union so packs can later contribute
 * additional extractors without touching this enum.
 */
export type FrameworkName = 'nestjs' | 'react' | 'express' | 'angular' | 'vue' | 'svelte' | string;

/**
 * NestJS subtypes the built-in extractor emits today.
 */
export type NestSubtype = 'controller' | 'module' | 'provider' | 'route';

/**
 * React subtypes the built-in extractor emits today.
 */
export type ReactSubtype = 'component' | 'hook-usage';

export interface IFrameworkManifest {
  schema: FrameworkSchemaVersion;
  projectRoot: string;
  lastBuiltAt: string;
  lastBuildDurationMs: number;
  /** SHA-256 of the framework store's JSONL files. */
  digest: string;
  /** Per-framework entity counts. */
  countsByFramework: Readonly<Record<string, number>>;
  /** Per-(framework + subtype) counts. */
  countsBySubtype: Readonly<Record<string, number>>;
  /** Frameworks active in this snapshot. */
  frameworks: readonly string[];
}

export interface IFrameworkSnapshot {
  manifest: IFrameworkManifest;
  nodes: ReadonlyMap<string, INode>;
  edges: ReadonlyMap<string, IEdge>;
}
