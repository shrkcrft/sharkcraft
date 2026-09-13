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
   * Local task-routing-hint and playbook registry files, relative to
   * `sharkcraftDir`, loaded in addition to the conventional
   * `task-routing-hints.ts` / `playbooks.ts`. See docs/task-routing-hints.md
   * and docs/playbooks.md.
   */
  taskRoutingHintFiles?: readonly string[];
  playbookFiles?: readonly string[];

  /**
   * Local convention files, relative to `sharkcraftDir`, loaded in addition to
   * the conventional `conventions.ts` / `conventions/index.ts`. Packs contribute
   * the same shape via their manifest's `conventionFiles`.
   */
  conventionFiles?: readonly string[];

  /**
   * Ownership rule files for `shrk owners` / `shrk ownership` and the MCP
   * ownership tools. Default: `sharkcraft/ownership.ts` + CODEOWNERS.
   */
  ownershipFiles?: readonly string[];

  /**
   * Knowledge stale-check folded into `shrk release readiness`
   * (docs/knowledge-integrity.md).
   */
  knowledgeCheck?: {
    readonly enabled?: boolean;
    readonly strict?: boolean;
    readonly failOn?: readonly (
      | 'required'
      | 'stale'
      | 'missing'
      | 'all'
      | 'unverifiable'
      | 'path-missing'
      | 'anchor-missing'
      | 'content'
      | 'count'
      | 'aged'
      | 'implicit'
      | 'invalid'
    )[];
    /**
     * Minimum share (0..1) of in-scope entries the check can examine. Both an
     * explicit acceptance of the remaining unverifiable entries (printed, never
     * silent) and a ratchet: below it `knowledge stale-check` fails.
     */
    readonly minReferenced?: number;
    /** Every in-scope entry must declare a checkable reference. */
    readonly requireReferences?: boolean;
  };

  /**
   * Project-wide quality-gate thresholds for `shrk quality`; the matching CLI
   * flags override them (docs/quality-gates.md).
   */
  qualityGates?: {
    readonly minReadiness?: number;
    readonly requireBoundaryClean?: boolean;
    readonly requireDriftClean?: boolean;
    readonly requireAgentTests?: boolean;
    readonly requireContextTests?: boolean;
    readonly requirePackSignatures?: boolean;
  };

  /**
   * Recommender tuning for `shrk recommend`, MCP `recommend_commands` and
   * `shrk context` (docs/command-entrypoints.md).
   *   - `minScore` — the confidence floor multiplier (> 0), in normalised units
   *     where 1.0 is each signal source's own floor. `--min-score` (CLI) and
   *     `minScore` (MCP) override it.
   *   - `scaffoldRequiresCreateIntent` — default true: a source-writing command
   *     (`shrk gen …`) is never recommended for a query that is not
   *     create/build work.
   */
  recommend?: {
    readonly minScore?: number;
    readonly scaffoldRequiresCreateIntent?: boolean;
  };

  /**
   * Per-policy severity / enable overrides, each with a reason
   * (docs/policy-checks.md).
   */
  policyOverrides?: readonly {
    readonly policyId: string;
    readonly severity?: 'info' | 'warning' | 'error' | 'critical';
    readonly enabled?: boolean;
    readonly reason?: string;
  }[];

  /**
   * Named, reusable extraction selectors — the DRY guarantee for the one thing
   * that must never disagree: WHICH SET are we talking about.
   *
   * A wiring rule's `declared`, a registry's `source`, and a baseline's
   * `compute.source` routinely describe the same id space. Spelled out three
   * times they drift — a directory move updated in two of three leaves the
   * planes silently checking different sets while all three still report a
   * confident pass. Define the selector once here and reference it with
   * `{ $use: "<id>" }` from any plane; fields set alongside `$use` override the
   * shared definition for that consumer only.
   *
   * Inline selectors keep working unchanged — `$use` is purely opt-in.
   */
  extractors?: Readonly<Record<string, IWiringSource>>;

  /**
   * Wiring/completeness rules — the "declared but not wired" plane. Each rule is
   * a data-defined cross-file set-membership check (a declared token set must be
   * a subset of a registered token set). Run via `shrk check wiring` and the
   * `wiring` quality gate. The engine is generic — projects supply the patterns.
   */
  wiringRules?: readonly IWiringRule[];

  /**
   * Declarable registry inventories — string-keyed contribution sets spread
   * across files. Each declaration reuses the wiring `{ files, pattern |
   * arrayProperty }` extractor to harvest the registry's ids. Queried via
   * `shrk registry <name> list | exists <id> | where <id>` — one deterministic
   * multi-root scan that replaces a fragile "is this id taken / where is it"
   * grep. The engine is generic — projects supply the patterns.
   */
  registries?: readonly IRegistryDeclaration[];

  /**
   * DI/registration idioms — the runtime-wiring graph plane. Each idiom names
   * the three roles (declared / provided / consumed) of a token-space, reusing
   * the wiring `{ files, pattern | arrayProperty }` extractor. Queried via
   * `shrk wiring chain <token>` (declared → provided → consumed with file:line),
   * `shrk wiring unprovided` (declared/injected but never provided — the
   * silent-at-runtime class), and `shrk wiring orphans` (provided, nothing
   * consumes). Generic + deterministic; projects/packs supply the idiom shapes.
   */
  registrationGraph?: readonly IRegistrationIdiom[];

  /**
   * Policy-lint rules — the template/style/ts content plane (markup + inline
   * `template:` strings, stylesheets, AOT-invisible TS shapes). Run via
   * `shrk policy-lint`. Generic + deterministic; projects supply the patterns.
   */
  policyRules?: readonly IPolicyRule[];

  /**
   * Baseline / ledger drift rules — the "committed artifact silently drifted"
   * plane. Each rule pairs a committed baseline file with a way to recompute
   * its current value (a shell command, or a pure extractor harvest). Run via
   * `shrk baseline check`; blessed via the explicit `shrk baseline update`.
   *
   * A `command` compute SPAWNS a shell, so it is honoured only from the repo's
   * own config — the pack-plane merge seam drops a pack-contributed one.
   */
  baselines?: readonly IBaselineRule[];

  /**
   * Generated-artifact drift + provenance rules. `shrk generated check`
   * regenerates into a temp dir and diffs both ways (catching a hand-edited
   * generated file AND a regen that writes a subset), and asserts the
   * "do not edit" header contract. A rule with no `regen` is header-only and
   * never spawns anything.
   *
   * As with `baselines`, a pack-contributed rule may NOT carry a `regen`
   * command.
   */
  generatedArtifacts?: readonly IGeneratedArtifactRule[];

  /**
   * Prose-reference rules — the "a doc cites an id that no longer exists"
   * plane. shrk validates the structured `references[]` on knowledge entries;
   * the same ids written as free text in a README, an architecture doc or an
   * agent skill file are unchecked, and markdown has no build behind it. Run
   * via `shrk docs references check`; joins `shrk gates` like every plane.
   */
  docReferences?: readonly IDocReferenceRule[];

  /**
   * Reuse primitives — role-keyed canonical symbols surfaced by `shrk reuse
   * <intent>` (resolved through the code graph to import path + consumers).
   */
  reusePrimitives?: readonly IReusePrimitive[];

  /**
   * `check registry-lifecycle` scan tuning.
   *
   *   - `skipDirsAdd` EXTENDS the default source-only skip set (build artefacts
   *     + examples/e2e/scripts/tools/…). This is the one to reach for: adding a
   *     project directory never un-skips `node_modules` or `dist`.
   *   - `skipDirs` REPLACES the default set — an advanced escape hatch for a
   *     repo that genuinely registers code under `tools/` or a non-standard
   *     root. A replacing list that drops a dependency/VCS/build default
   *     (`node_modules`, `dist`, `build`, …) is reported by the scan and by
   *     `shrk doctor`, never silently.
   */
  registryLifecycle?: {
    readonly skipDirs?: readonly string[];
    readonly skipDirsAdd?: readonly string[];
  };

  /**
   * Project-declared area patterns for the repository area map (`shrk repo
   * areas`, and every view derived from it — impact, review packets, the
   * report site). Patterns are evaluated FIRST, in declared order, then the
   * built-in table (unless `replaceDefaults`). `match` globs are
   * project-relative (e.g. `libs/<group>/core/**` with `*` for the group).
   * `minClassificationRate` (0..1,
   * default 0.5) is the rate below which the map reports itself `degraded`.
   */
  areaMap?: {
    readonly patterns?: readonly {
      readonly kind: AreaKind;
      readonly match: readonly string[];
      readonly id?: string;
    }[];
    readonly replaceDefaults?: boolean;
    readonly minClassificationRate?: number;
  };

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
export type { IDelegateRecipe, IDelegateRecipeMatch, DelegateRecipeMode, DelegateGroundingId, DelegateQueryId } from '@shrkcrft/core';
export { DELEGATE_GROUNDING_IDS, DELEGATE_QUERY_IDS } from '@shrkcrft/core';
import type { IDelegateRecipe } from '@shrkcrft/core';
// Wiring rules live in core so config (validation) + boundaries (engine) share
// one contract; re-export for `import { IWiringRule } from '@shrkcrft/config'`.
export type { IWiringRule, IWiringSource } from '@shrkcrft/core';
import type { IWiringRule, IWiringSource } from '@shrkcrft/core';
// Registry declarations live in core too; re-export for config consumers.
export type { IRegistryDeclaration } from '@shrkcrft/core';
import type { IRegistryDeclaration } from '@shrkcrft/core';
// Registration idioms (the DI/wiring graph plane) also live in core.
export type { IRegistrationIdiom } from '@shrkcrft/core';
import type { IRegistrationIdiom } from '@shrkcrft/core';
// Policy-lint + reuse contracts also live in core; re-export for consumers.
export type { IPolicyRule, PolicySurface, PolicyScanZone, IReusePrimitive } from '@shrkcrft/core';
import type { IPolicyRule, IReusePrimitive } from '@shrkcrft/core';
// Baseline-drift + generated-artifact contracts likewise live in core.
export type {
  IBaselineRule,
  IBaselineCompute,
  IGeneratedArtifactRule,
  IProvenanceHeaderRule,
  IRuleSelfTest,
} from '@shrkcrft/core';
import type { IBaselineRule, IGeneratedArtifactRule, IDocReferenceRule } from '@shrkcrft/core';
import type { AreaKind } from '@shrkcrft/core';
import type { ISharkCraftConfigInput } from './i-sharkcraft-config-input.ts';
export type { IDocReferenceRule, DocReferenceContext } from '@shrkcrft/core';

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
  /**
   * Deny list (round 11): commands that are NOT callable in this repository
   * (the surface gate refuses them with exit 78) and never appear in `--help`.
   * Entries are exact command paths or group selectors (`'bundle *'` names
   * `bundle` and every command below it) — the same selector syntax
   * `enabled` / `hidden` accept. Core commands cannot be disabled (a warning).
   * A profile's deny is overridden by an explicit `enabled` entry here; a deny
   * declared here wins over `enabled` (warning `enable-disable-conflict`).
   */
  disabled?: readonly string[];
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

/**
 * Type the authored config. Takes the AUTHORED shape (round 13,
 * {@link ISharkCraftConfigInput}): a gate plane's markable lists accept `{
 * pattern, expectEmpty: true, reason? }` entries, which the loader validates
 * and normalises into the loaded {@link ISharkCraftConfig}. Returns its
 * argument unchanged.
 */
export function defineSharkCraftConfig<T extends ISharkCraftConfigInput>(config: T): T {
  return config;
}
