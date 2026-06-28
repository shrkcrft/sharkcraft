export interface ISharkCraftConfig {
  /** Optional project identifier used in outputs / context. */
  projectName?: string;

  /** Human-readable one-line project description. */
  description?: string;

  /** Folder (relative to project root) containing SharkCraft project data. */
  sharkcraftDir?: string;

  /** Knowledge entry files (TS or markdown). Relative to sharkcraftDir. */
  knowledgeFiles?: string[];

  /** Markdown doc files (optional human depth). Relative to sharkcraftDir. */
  docsFiles?: string[];

  /** Rule registry files. */
  ruleFiles?: string[];

  /** Path-convention registry files. */
  pathFiles?: string[];

  /** Template registry files. */
  templateFiles?: string[];

  /** Pipeline registry files. */
  pipelineFiles?: string[];

  /** Default token budget for context retrieval. */
  defaultMaxTokens?: number;

  /** Default frameworks/scopes this project belongs to. */
  defaultScope?: string[];

  /** Toggle action-hint quality diagnostics in doctor. Default true. */
  actionHintDiagnostics?: boolean;

  /** Free-form metadata. */
  metadata?: Record<string, unknown>;

  /**
   * Verification commands available to `shrk apply --validate --verification <id>`.
   * Only commands defined here (with `trusted: true`) run by default. Pack-
   * contributed commands are intentionally **not** auto-run in v1 — pass
   * `--allow-pack-commands` to opt in to a future feature.
   */
  verificationCommands?: readonly IVerificationCommand[];

  /**
   * Local preset/boundary/context-test/agent-test files. Populated by the
   * inspector but typed here for completeness.
   */
  presetFiles?: readonly string[];
  boundaryFiles?: readonly string[];
  contextTestFiles?: readonly string[];
  agentTestFiles?: readonly string[];

  /**
   * Wiring/completeness rules — the "declared but not wired" plane. Each rule is
   * a data-defined cross-file set-membership check (a declared token set must be
   * a subset of a registered token set). Run via `shrk check wiring` and the
   * `wiring` quality gate. The engine is generic — projects supply the patterns.
   */
  wiringRules?: readonly IWiringRule[];

  /**
   * Policy-lint rules — the template/style/ts content plane (markup + inline
   * `template:` strings, stylesheets, AOT-invisible TS shapes). Run via
   * `shrk policy-lint`. Generic + deterministic; projects supply the patterns.
   */
  policyRules?: readonly IPolicyRule[];

  /**
   * Reuse primitives — role-keyed canonical symbols surfaced by `shrk reuse
   * <intent>` (resolved through the code graph to import path + consumers).
   */
  reusePrimitives?: readonly IReusePrimitive[];

  /**
   * Adaptive surface gating.
   *
   *   - `enabled`: experimental commands the project opts into.
   *     Pack-contributed commands and entries marked `hidden: true` in
   *     the catalog default to tier=`experimental`; they're listed by
   *     `shrk surface list` but invisible in `--help` and refuse on
   *     invocation until added here.
   *   - `hidden`: extended commands the project chooses to hide from
   *     `--help`. They remain callable. Used by shape-aware init to
   *     hide monorepo-only commands in a single-app repo.
   *
   * Core commands cannot appear in either list — the resolver flags
   * such configs in `shrk surface list --json` and `shrk doctor`.
   */
  surface?: ISurfaceConfig;

  /**
   * Local usage log opt-out.
   *
   * Defaults to `{ enabled: true }`. When disabled, no entries are
   * written to `.sharkcraft/usage/commands.jsonl`. The env var
   * `SHARKCRAFT_USAGE_DISABLED=1` also disables the writer
   * regardless of this field.
   */
  usage?: IUsageConfig;

  /**
   * Local-LLM delegate worker configuration (see `shrk delegate`).
   *
   * Declares the MECHANICAL task recipes a repo lets a local model produce
   * edits for. Every recipe's edit enters the world only as a signed synthetic
   * plan that the deterministic engine verifies — so a recipe is just a fenced
   * description of a delegatable task, never executable code.
   */
  delegation?: IDelegationConfig;
}

// The recipe contract lives in `core` so the pack contract (`@shrkcrft/plugin-api`)
// can share it; re-export it here for `import { IDelegateRecipe } from '@shrkcrft/config'`.
export type { IDelegateRecipe, IDelegateRecipeMatch } from '@shrkcrft/core';
import type { IDelegateRecipe } from '@shrkcrft/core';
// Wiring rules live in core so config (validation) + boundaries (engine) share
// one contract; re-export for `import { IWiringRule } from '@shrkcrft/config'`.
export type { IWiringRule, IWiringSource } from '@shrkcrft/core';
import type { IWiringRule } from '@shrkcrft/core';
// Policy-lint + reuse contracts also live in core; re-export for consumers.
export type { IPolicyRule, PolicySurface, IReusePrimitive } from '@shrkcrft/core';
import type { IPolicyRule, IReusePrimitive } from '@shrkcrft/core';

/**
 * Per-recipe override, keyed by recipe id. Lets a project tune a PACK-contributed
 * recipe (or disable it) without forking it — change the model / verification /
 * guardrail globs, or set `enabled: false` to drop it from the catalog.
 */
export interface IDelegateRecipeOverride {
  model?: string;
  verificationIds?: readonly string[];
  guardrailGlobs?: readonly string[];
  enabled?: boolean;
}

/** Project-level delegate-worker settings + the recipe catalog. */
export interface IDelegationConfig {
  /** Master switch; when false, `shrk delegate run` refuses. Default true. */
  enabled?: boolean;
  /** Default local provider for every recipe that doesn't override it. */
  provider?: 'auto' | 'ollama' | 'llamacpp';
  /** Default model for every recipe that doesn't override it. */
  model?: string;
  /** Inline project recipes. */
  recipes?: readonly IDelegateRecipe[];
  /** Overrides for pack- (or inline-) contributed recipes, keyed by recipe id. */
  recipeOverrides?: Readonly<Record<string, IDelegateRecipeOverride>>;
}

export interface ISurfaceConfig {
  /**
   * Named profile (e.g. `small-app`, `monorepo`,
   * `pack-author`, `ci`, `agent`). Built-in profiles ship from the
   * engine; packs may contribute additional profiles via the pack
   * manifest. When set, the profile's `hidden[]` + `enabled[]`
   * merge with the explicit arrays below (config wins on conflicts).
   */
  profile?: string;
  enabled?: readonly string[];
  hidden?: readonly string[];
}

export interface IUsageConfig {
  enabled?: boolean;
}

export interface IVerificationCommand {
  /** Stable id used by `--verification <id>`. */
  id: string;
  /** Human-readable label. */
  label?: string;
  /** Shell command to execute. */
  command: string;
  /** `true` opts the command into the default run set. */
  trusted?: boolean;
}

export const DEFAULT_SHARKCRAFT_DIR = 'sharkcraft';

export const DEFAULT_KNOWLEDGE_FILES = ['knowledge.ts', 'knowledge/index.ts'];
export const DEFAULT_RULE_FILES = ['rules.ts', 'knowledge/rules.ts'];
export const DEFAULT_PATH_FILES = ['paths.ts', 'knowledge/paths.ts'];
export const DEFAULT_TEMPLATE_FILES = ['templates.ts', 'knowledge/templates.ts'];
export const DEFAULT_PIPELINE_FILES = ['pipelines.ts', 'knowledge/pipelines.ts'];
export const DEFAULT_DOC_FILES = [
  'docs/overview.md',
  'docs/architecture.md',
  'docs/quick-start.md',
];

export function defineSharkCraftConfig(config: ISharkCraftConfig): ISharkCraftConfig {
  return config;
}
