import type { WorkspaceProfile } from '@shrkcrft/workspace';

/**
 * A preset is a reusable, additive SharkCraft project setup. Presets are
 * applied to a target repo through the CLI — never through MCP.
 *
 * Presets ship **content** (knowledge / rules / paths / templates / pipelines /
 * docs / tasks) plus metadata describing where they fit and what should
 * happen next. They are NOT executable code; they are typed data the
 * apply step renders into source files in the consumer's sharkcraft/ folder.
 */
export interface IPresetFile {
  /** Relative path inside the target's sharkcraft/ folder. */
  path: string;
  /** Literal content to write. */
  content: string;
}

export interface IPresetIncludes {
  /** TS expressions for KnowledgeEntry objects (rendered into knowledge.ts). */
  knowledge?: readonly string[];
  /** TS expressions for KnowledgeEntry-shaped rule objects. */
  rules?: readonly string[];
  /** TS expressions for PathConvention KnowledgeEntry objects. */
  paths?: readonly string[];
  /** TS expressions for ITemplateDefinition objects. */
  templates?: readonly string[];
  /** TS expressions for IPipelineDefinition objects. */
  pipelines?: readonly string[];
  /** Filename → markdown content for sharkcraft/docs/<filename>. */
  docs?: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
  /** Filename → markdown content for sharkcraft/tasks/<filename>. */
  tasks?: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
  // ── References: resolve existing assets from the inspection registries
  // (built-in/local/pack) by id, instead of embedding TS source. v1 behavior:
  // these IDs are surfaced in preview output and the task packet; missing
  // ids become warnings; nothing is written to disk for referenced assets.
  knowledgeIds?: readonly string[];
  ruleIds?: readonly string[];
  pathConventionIds?: readonly string[];
  templateIds?: readonly string[];
  pipelineIds?: readonly string[];
}

export interface IPreset {
  /** Stable id (slug-style). */
  id: string;
  /** Short human title. */
  title: string;
  /** Free-form description. */
  description: string;
  /** Tags for grouping/filtering. */
  tags?: readonly string[];
  /** Profile tags this preset is appropriate for (used by recommendation). */
  appliesTo?: readonly WorkspaceProfile[];
  /** Profile tags this preset is INappropriate for (used by recommendation). */
  notAppropriateFor?: readonly WorkspaceProfile[];
  /** Higher = stronger recommendation when applicable. Default 5 (1..10). */
  weight?: number;
  /** Bundled content to merge into the target's sharkcraft/ folder. */
  includes: IPresetIncludes;
  /** Verbatim file writes (non-knowledge files). */
  filesToCreate?: readonly IPresetFile[];
  /** Notes printed after `shrk presets apply --write` finishes. */
  postInstallNotes?: readonly string[];
  /** Commands the human should run next. */
  recommendedNextCommands?: readonly string[];
  /** Free-form safety notes printed before any write. */
  safetyNotes?: readonly string[];
  /** Other preset ids this one composes; applied first, current preset wins. */
  composes?: readonly string[];
  /**
   * Surface profile id this preset selects when
   * applied via `shrk init`. The init flow writes `surface.profile:
   * '<id>'` into the generated `sharkcraft.config.ts`. Set to one of
   * the built-in profile ids (`developer`, `small-app`, `monorepo`,
   * `pack-author`, `ci`, `agent`) or a pack-contributed profile id.
   */
  surfaceProfile?: string;
}

export interface IPresetValidationIssue {
  field: string;
  message: string;
}

export interface IPresetValidationResult {
  valid: boolean;
  issues: IPresetValidationIssue[];
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export function validatePreset(value: unknown): IPresetValidationResult {
  const issues: IPresetValidationIssue[] = [];
  if (!value || typeof value !== 'object') {
    return { valid: false, issues: [{ field: '<root>', message: 'preset must be an object' }] };
  }
  const p = value as Record<string, unknown>;
  if (typeof p.id !== 'string' || !ID_PATTERN.test(p.id)) {
    issues.push({ field: 'id', message: 'id must be a slug-style string' });
  }
  if (typeof p.title !== 'string' || p.title.length === 0) {
    issues.push({ field: 'title', message: 'title required' });
  }
  if (typeof p.description !== 'string' || p.description.length === 0) {
    issues.push({ field: 'description', message: 'description required' });
  }
  if (!p.includes || typeof p.includes !== 'object') {
    issues.push({ field: 'includes', message: 'includes object required' });
  }
  return { valid: issues.length === 0, issues };
}
