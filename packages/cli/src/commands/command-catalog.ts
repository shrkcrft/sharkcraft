export enum SafetyLevel {
  ReadOnly = 'read-only',
  WritesSessionOnly = 'writes-session',
  WritesDraftsOnly = 'writes-drafts',
  WritesSource = 'writes-source',
  RunsShell = 'runs-shell',
  RequiresReview = 'requires-review',
}

/**
 * Surface classification for "which command should I reach for first?"
 *
 * Distinct axis from {@link SafetyLevel}. Many `read-only` commands are
 * machine-oriented or legacy; many `writes-source` commands are the canonical
 * generate path.
 */
export enum CommandSurface {
  Primary = 'primary',
  Common = 'common',
  Advanced = 'advanced',
  Machine = 'machine',
  Internal = 'internal',
  Legacy = 'legacy',
}

/** Who is the command for? */
export enum CommandAudience {
  Human = 'human',
  Agent = 'agent',
  Ci = 'ci',
  PackAuthor = 'pack-author',
  Maintainer = 'maintainer',
}

/**
 * User-journey role. Distinct from {@link SafetyLevel} and from the
 * domain-grouping `category` field.
 *
 * Existing entries that don't set
 * {@link ICommandCatalogEntry.taskRole} are unaffected.
 */
export enum CommandTaskRole {
  Start = 'start',
  Context = 'context',
  Search = 'search',
  Explain = 'explain',
  Generate = 'generate',
  Review = 'review',
  Validate = 'validate',
  Release = 'release',
  Diagnose = 'diagnose',
  Inspect = 'inspect',
  Apply = 'apply',
  Config = 'config',
}

/**
 * Lifecycle axis (orthogonal to {@link CommandSurface}). Captures
 * whether a command is the current canonical answer, an alias, deprecated,
 * or retired.
 *
 * Defaults to {@link CommandLifecycle.Active} when omitted.
 */
export enum CommandLifecycle {
  Active = 'active',
  Preferred = 'preferred',
  Alias = 'alias',
  Deprecated = 'deprecated',
  Retired = 'retired',
}

/**
 * Tier axis. Orthogonal to {@link CommandSurface} and
 * {@link CommandLifecycle}.
 *
 *   - `Core` — always visible, always callable. Bootstrap commands +
 *     anything referenced from the spine pipelines. Cannot be hidden
 *     or disabled by config.
 *   - `Extended` — visible in `--help` (subject to
 *     {@link defaultShowInHelp}), always callable. Default for the
 *     bulk of catalog entries. Can be hidden via
 *     `sharkcraft.config.ts surface.hidden`.
 *   - `Experimental` — visible only in `shrk surface list`; refuses
 *     invocation with a structured not-enabled error unless added to
 *     `sharkcraft.config.ts surface.enabled`. Default for
 *     pack-contributed commands and any catalog entry with the
 *     catalog override `tier: CommandTier.Experimental`.
 *
 * The tier of any given command is computed by the resolver in
 * `packages/cli/src/surface/tier-resolver.ts` — the catalog field
 * `tier?:` is an override for narrow corner cases only. Mechanical
 * derivation (bootstrap ∪ spine) wins over any override that would
 * downgrade a core command.
 */
export enum CommandTier {
  Core = 'core',
  Extended = 'extended',
  Experimental = 'experimental',
}

export interface ICommandCatalogEntry {
  command: string;
  description: string;
  category: string;
  safetyLevel: SafetyLevel;
  writesFiles: boolean;
  writesSource: boolean;
  runsShell: boolean;
  requiresReview: boolean;
  mcpAvailable: boolean;
  aliases: readonly string[];
  /**
   * Optional surface classification. When omitted the helper
   * `commandSurface(entry)` derives a default from existing fields
   * (writesSource ⇒ Common; runsShell ⇒ Advanced; everything else ⇒ Common).
   */
  surface?: CommandSurface;
  /** Optional intended audience list. Defaults to `[Human]`. */
  intendedAudience?: readonly CommandAudience[];
  /** Optional user-journey role. */
  taskRole?: CommandTaskRole;
  /**
   * When this command is *not* the canonical entrypoint, a short string
   * (a CLI invocation) pointing to the one users should reach for first.
   * E.g. on `task` ⇒ `'shrk recommend "<task>"'`.
   */
  preferredCommand?: string;
  /**
   * Other commands that overlap with this one. Renderer surfaces the
   * relationship; doctor flags any overlapping entry without a
   * `preferredCommand`.
   */
  overlapsWith?: readonly string[];
  /** If the command is legacy/deprecated, what replaces it. */
  replacedBy?: string;
  /**
   * True if the command's primary consumer is machines / JSON pipes.
   * Doctor flags `machineOnly && surface=Primary` as a UX warning.
   */
  machineOnly?: boolean;
  /**
   * Optional lifecycle classification. Defaults to
   * {@link CommandLifecycle.Active}. Set to `Alias` when the entry is a
   * synonym pointing at a canonical command (see {@link replacedBy} or
   * {@link preferredCommand}); `Deprecated` when scheduled for removal;
   * `Retired` for tombstone entries kept only for catalog history.
   */
  lifecycle?: CommandLifecycle;
  /** Round / version where the lifecycle status started. */
  deprecatedSince?: string;
  /** Round / version after which the entry should be removed. */
  removeAfter?: string;
  /**
   * Free-form reason explaining the lifecycle status. Surfaced by
   * `shrk commands deprecated` / `commands retirement-plan` and by the
   * `commands ux-check` doctor.
   */
  reason?: string;
  /**
   * Override default-help visibility. When omitted the renderer
   * uses {@link defaultShowInHelp} (primary + common visible; advanced /
   * machine / internal / legacy hidden unless explicitly requested).
   */
  showInDefaultHelp?: boolean;
  /**
   * Optional explicit tier. When set, overrides the mechanical
   * derivation in the tier resolver UNLESS the command is in the
   * bootstrap set or referenced from the spine — those always resolve
   * to {@link CommandTier.Core} regardless of this field.
   *
   * Use sparingly: the right place to mark a command as
   * `Experimental` is via the pruning overlay or by giving it the
   * surface `Internal`/`Legacy` classification. This field exists for
   * cases where the tier needs to differ from what surface + lifecycle
   * imply.
   */
  tier?: CommandTier;
}

/**
 * Static catalog of `shrk` commands. The metadata is curated rather than
 * derived so that it stays accurate even when commands evolve. Tests check
 * the structural invariants (no duplicate commands, every entry has a
 * non-empty description).
 */
export const COMMAND_CATALOG: readonly ICommandCatalogEntry[] = Object.freeze([
  entry({
    command: 'doctor',
    description: 'Workspace doctor: config + entry validation.',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
    surface: CommandSurface.Primary,
    intendedAudience: [CommandAudience.Human, CommandAudience.Agent, CommandAudience.Ci],
    taskRole: CommandTaskRole.Diagnose,
  }),
  entry({
    command: 'ai-status',
    description:
      'Report which AI provider shrk would use right now, with setup or upgrade hints. `--ping` verifies the provider actually responds.',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: false,
    surface: CommandSurface.Common,
    intendedAudience: [CommandAudience.Human, CommandAudience.Agent],
    taskRole: CommandTaskRole.Diagnose,
  }),
  entry({
    command: 'context',
    description:
      'Focused context for a task (rules / paths / templates). For "what should I do?" prefer `shrk recommend "<task>"`.',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
    surface: CommandSurface.Primary,
    intendedAudience: [CommandAudience.Human, CommandAudience.Agent],
    taskRole: CommandTaskRole.Context,
    preferredCommand: 'shrk recommend "<task>"',
    overlapsWith: ['recommend', 'task'],
  }),
  entry({
    command: 'task',
    description:
      'Machine task packet (rules + templates + pipelines + commands). Primary consumer is agents / JSON pipes — humans usually want `shrk recommend "<task>"`.',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
    surface: CommandSurface.Machine,
    intendedAudience: [CommandAudience.Agent, CommandAudience.Ci],
    taskRole: CommandTaskRole.Context,
    preferredCommand: 'shrk recommend "<task>"',
    overlapsWith: ['recommend', 'context'],
    machineOnly: true,
  }),
  entry({
    command: 'inspect',
    description: 'Aggregate inspection of registries + packs.',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
    surface: CommandSurface.Common,
    taskRole: CommandTaskRole.Inspect,
  }),
  // Adaptive surface tier introspection + management.
  entry({
    command: 'surface',
    description:
      'Inspect / change the adaptive command surface. Subcommands: list, enable, disable, hide, unhide, reset, explain.',
    category: 'core',
    safetyLevel: SafetyLevel.WritesSource,
    writesFiles: true,
    mcpAvailable: false,
    surface: CommandSurface.Primary,
    intendedAudience: [CommandAudience.Human, CommandAudience.Agent],
    taskRole: CommandTaskRole.Config,
  }),
  // `surface` subcommands. The top-level `surface` is Primary
  // and visible; the verbs are Advanced so they don't bloat the default
  // --help. Users discover them via `shrk surface --help` (the trie
  // dispatcher renders the group's verbs there).
  entry({
    command: 'surface list',
    description: 'List every command grouped by tier (core / extended / experimental).',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: false,
    surface: CommandSurface.Advanced,
    taskRole: CommandTaskRole.Inspect,
  }),
  entry({
    command: 'surface enable',
    description: 'Enable an experimental command (preview-first; pass --write to apply).',
    category: 'core',
    safetyLevel: SafetyLevel.WritesSource,
    writesFiles: true,
    surface: CommandSurface.Advanced,
    taskRole: CommandTaskRole.Config,
  }),
  entry({
    command: 'surface disable',
    description: 'Undo a prior `surface enable` (preview-first).',
    category: 'core',
    safetyLevel: SafetyLevel.WritesSource,
    writesFiles: true,
    surface: CommandSurface.Advanced,
    taskRole: CommandTaskRole.Config,
  }),
  entry({
    command: 'surface hide',
    description: 'Hide an extended command from --help (still callable). Preview-first.',
    category: 'core',
    safetyLevel: SafetyLevel.WritesSource,
    writesFiles: true,
    surface: CommandSurface.Advanced,
    taskRole: CommandTaskRole.Config,
  }),
  entry({
    command: 'surface unhide',
    description: 'Reverse a prior `surface hide` (preview-first).',
    category: 'core',
    safetyLevel: SafetyLevel.WritesSource,
    writesFiles: true,
    surface: CommandSurface.Advanced,
    taskRole: CommandTaskRole.Config,
  }),
  entry({
    command: 'surface reset',
    description: 'Clear surface.enabled + surface.hidden in sharkcraft.config.ts (preview-first).',
    category: 'core',
    safetyLevel: SafetyLevel.WritesSource,
    writesFiles: true,
    surface: CommandSurface.Advanced,
    taskRole: CommandTaskRole.Config,
  }),
  entry({
    command: 'surface explain',
    description: 'Explain why a command has its current tier (bootstrap / spine / pack / override).',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    surface: CommandSurface.Advanced,
    taskRole: CommandTaskRole.Explain,
  }),
  entry({
    command: 'surface profiles',
    description: 'List or inspect named surface profiles (developer / small-app / monorepo / pack-author / ci / agent + pack-contributed).',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    surface: CommandSurface.Advanced,
    taskRole: CommandTaskRole.Inspect,
  }),
  entry({
    command: 'coverage',
    description: 'Coverage report across knowledge axes.',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
    surface: CommandSurface.Primary,
    intendedAudience: [CommandAudience.Human, CommandAudience.Ci],
    taskRole: CommandTaskRole.Inspect,
  }),
  entry({
    command: 'drift',
    description: 'Stale-entry drift report.',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
    surface: CommandSurface.Common,
    taskRole: CommandTaskRole.Validate,
  }),
  entry({
    command: 'graph',
    description:
      'Knowledge graph plus code-intelligence subverbs (`index`, `status`, `search`, `context`, `impact`, `callers`, `cycles`, `unresolved`, `deps`, `why`, `export`).',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
    surface: CommandSurface.Common,
    taskRole: CommandTaskRole.Inspect,
  }),
  entry({
    command: 'rule-graph',
    description:
      'Bridge the code graph to asset registries (boundary rules, path conventions, templates). Sub-verbs: index, status, for <file>.',
    category: 'core',
    safetyLevel: SafetyLevel.WritesSessionOnly,
    mcpAvailable: true,
    surface: CommandSurface.Common,
    taskRole: CommandTaskRole.Inspect,
  }),
  entry({
    command: 'search-structural',
    description:
      'Declarative AST pattern search over the project. Read-only; no rewrites in this round.',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
    surface: CommandSurface.Common,
    taskRole: CommandTaskRole.Inspect,
  }),
  entry({
    command: 'plan-context',
    description:
      'Produce a deterministic, token-budgeted context pack (`sharkcraft.context-pack/v1`) for an AI coding agent.',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
    surface: CommandSurface.Common,
    taskRole: CommandTaskRole.Context,
  }),
  entry({
    command: 'arch',
    description:
      'Architecture-guard checks (public-API misuse, barrel risks, cycle severity, project contracts).',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
    surface: CommandSurface.Common,
    taskRole: CommandTaskRole.Validate,
  }),
  entry({
    command: 'framework',
    description:
      'Framework-aware extractors: NestJS controllers/modules/providers/routes, React components/hook usages. Sub-verbs: index, status, list, routes.',
    category: 'core',
    safetyLevel: SafetyLevel.WritesSessionOnly,
    mcpAvailable: true,
    surface: CommandSurface.Common,
    taskRole: CommandTaskRole.Inspect,
  }),
  entry({
    command: 'api-diff',
    description:
      'Compare the current public API surface to a baseline. Reports added / removed / kind-changed / moved symbols with breaking-change severity.',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
    surface: CommandSurface.Common,
    taskRole: CommandTaskRole.Validate,
  }),
  entry({
    command: 'gate',
    description:
      'Aggregator quality-gate: graph freshness + architecture + impact-since-ref → one pass/fail. The pre-merge gate for AI-agent-authored changes.',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
    surface: CommandSurface.Common,
    taskRole: CommandTaskRole.Validate,
  }),
  entry({
    command: 'migrate',
    description:
      'Run a multi-step migration: structural rewrites + shell + checks orchestrated as one replayable plan.',
    category: 'core',
    safetyLevel: SafetyLevel.WritesSource,
    mcpAvailable: false,
    surface: CommandSurface.Common,
    taskRole: CommandTaskRole.Generate,
  }),
  entry({
    command: 'code-intel',
    description:
      'One-shot view of code-intelligence doctor checks (graph, rule-graph, api-surface, quality-gate, migrations, architecture, impact, framework, structural-search, context-planner). Read-only.',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
    surface: CommandSurface.Common,
    taskRole: CommandTaskRole.Diagnose,
  }),
  entry({
    command: 'check',
    description: 'Run validation checks across registries / packs / boundaries.',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: false,
    surface: CommandSurface.Common,
    taskRole: CommandTaskRole.Validate,
  }),
  // Changed-only preflight orchestrator.
  entry({
    command: 'preflight',
    description:
      'Changed-only preflight orchestrator. Picks read-only gates from the change-set; --explain prints the plan without executing.',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: false,
    surface: CommandSurface.Common,
    taskRole: CommandTaskRole.Validate,
  }),
  entry({
    command: 'check boundaries',
    description: 'Boundary enforcement against tsconfig aliases + import graph.',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
    surface: CommandSurface.Common,
    taskRole: CommandTaskRole.Validate,
  }),
  entry({
    command: 'diff-check',
    description: 'Self-check current git diff against boundary + import-hygiene rules. Single-call composite for agents to validate edits before declaring done. Read-only.',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
    surface: CommandSurface.Common,
    taskRole: CommandTaskRole.Validate,
  }),
  entry({
    command: 'review',
    description: 'PR-review packet — changed files, affected rules, missing tests heuristic.',
    category: 'review',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'review render-comment',
    description: 'Render PR-comment markdown from a review packet (--output writes file).',
    category: 'review',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
  }),
  entry({
    command: 'init',
    description: 'Create the sharkcraft/ folder + config skeleton.',
    category: 'core',
    safetyLevel: SafetyLevel.WritesSource,
    writesFiles: true,
    writesSource: true,
    surface: CommandSurface.Common,
    taskRole: CommandTaskRole.Start,
  }),
  entry({
    command: 'gen',
    description: 'Generate from a template (dry-run by default, --save-plan/--write to apply).',
    category: 'core',
    safetyLevel: SafetyLevel.WritesSource,
    writesFiles: true,
    writesSource: true,
    requiresReview: true,
    surface: CommandSurface.Primary,
    intendedAudience: [CommandAudience.Human],
    taskRole: CommandTaskRole.Generate,
  }),
  entry({
    command: 'apply',
    description: 'Apply a saved plan — writes source files (the CLI is the only write path).',
    category: 'core',
    safetyLevel: SafetyLevel.WritesSource,
    writesFiles: true,
    writesSource: true,
    requiresReview: true,
    surface: CommandSurface.Common,
    taskRole: CommandTaskRole.Apply,
  }),
  entry({
    command: 'delegate',
    description:
      'Hand a mechanical edit to a local-LLM worker; the engine verifies the result and auto-reverts on failure (run|brief). Writes source only via --apply through the signed-plan + verify gate.',
    category: 'core',
    safetyLevel: SafetyLevel.WritesSource,
    writesFiles: true,
    writesSource: true,
    requiresReview: true,
    surface: CommandSurface.Advanced,
    intendedAudience: [CommandAudience.Human, CommandAudience.Agent],
    taskRole: CommandTaskRole.Apply,
  }),
  // `shrk spec` intent artifact over plan/review/apply.
  entry({
    command: 'spec',
    description:
      'Spec-driven development: scaffold, review, implement, verify intent artifacts under .sharkcraft/specs/.',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    surface: CommandSurface.Common,
    intendedAudience: [CommandAudience.Human, CommandAudience.Agent],
    taskRole: CommandTaskRole.Start,
  }),
  entry({
    command: 'spec create',
    description: 'Scaffold a grounded spec under .sharkcraft/specs/. Preview-only by default.',
    category: 'core',
    safetyLevel: SafetyLevel.WritesSessionOnly,
    writesFiles: true,
    surface: CommandSurface.Advanced,
    intendedAudience: [CommandAudience.Human, CommandAudience.Agent],
    taskRole: CommandTaskRole.Start,
  }),
  entry({
    command: 'spec review',
    description: 'Structural + cross-registry validation of a spec.',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    surface: CommandSurface.Advanced,
    intendedAudience: [CommandAudience.Human, CommandAudience.Agent],
    taskRole: CommandTaskRole.Inspect,
  }),
  entry({
    command: 'spec implement',
    description:
      'Compose the spec\'s proposedTemplates into a signed combined plan (dry-run, --write-plan, --apply).',
    category: 'core',
    safetyLevel: SafetyLevel.WritesSessionOnly,
    writesFiles: true,
    requiresReview: true,
    surface: CommandSurface.Advanced,
    intendedAudience: [CommandAudience.Human, CommandAudience.Agent],
    taskRole: CommandTaskRole.Generate,
  }),
  entry({
    command: 'spec verify',
    description:
      'Run trusted verification commands + diff-aware boundary + scope-drift checks on a spec.',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    surface: CommandSurface.Advanced,
    intendedAudience: [CommandAudience.Human, CommandAudience.Agent],
    taskRole: CommandTaskRole.Validate,
  }),
  entry({
    command: 'spec list',
    description: 'List every spec in .sharkcraft/specs/.',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    surface: CommandSurface.Advanced,
    intendedAudience: [CommandAudience.Human, CommandAudience.Agent],
    taskRole: CommandTaskRole.Inspect,
  }),
  entry({
    command: 'spec show',
    description: 'Print a spec contents.',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    surface: CommandSurface.Advanced,
    intendedAudience: [CommandAudience.Human, CommandAudience.Agent],
    taskRole: CommandTaskRole.Inspect,
  }),
  entry({
    command: 'spec status',
    description: 'Read/transition a spec status (manual --set allowed only for "abandoned").',
    category: 'core',
    safetyLevel: SafetyLevel.WritesSessionOnly,
    writesFiles: true,
    surface: CommandSurface.Advanced,
    intendedAudience: [CommandAudience.Human, CommandAudience.Agent],
    taskRole: CommandTaskRole.Inspect,
  }),
  entry({
    command: 'spec lint',
    description: 'Fast structural-only lint of a spec (skips cross-registry resolution).',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    surface: CommandSurface.Advanced,
    intendedAudience: [CommandAudience.Human, CommandAudience.Agent],
    taskRole: CommandTaskRole.Inspect,
  }),
  entry({
    command: 'dev',
    description: 'Dev session workflow: start → plan → review → apply → validate → report.',
    category: 'dev',
    safetyLevel: SafetyLevel.WritesSessionOnly,
    writesFiles: true,
  }),
  entry({
    command: 'dev start',
    description: 'Start a dev session under .sharkcraft/sessions/.',
    category: 'dev',
    safetyLevel: SafetyLevel.WritesSessionOnly,
    writesFiles: true,
    mcpAvailable: false,
    surface: CommandSurface.Advanced,
    intendedAudience: [CommandAudience.Human],
    taskRole: CommandTaskRole.Start,
  }),
  entry({
    command: 'dev plan',
    description: 'Generate session plans + auto-review.',
    category: 'dev',
    safetyLevel: SafetyLevel.WritesSessionOnly,
    writesFiles: true,
  }),
  entry({
    command: 'dev validate',
    description: 'Run configured verification commands and record validation in session.',
    category: 'dev',
    safetyLevel: SafetyLevel.RunsShell,
    runsShell: true,
    writesFiles: true,
  }),
  entry({
    command: 'dev report',
    description: 'Write the final audit-trail report for the session.',
    category: 'dev',
    safetyLevel: SafetyLevel.WritesSessionOnly,
    writesFiles: true,
  }),
  entry({
    command: 'dev mark-applied',
    description: 'Metadata-only: mark a session plan applied. No source writes.',
    category: 'dev',
    safetyLevel: SafetyLevel.WritesSessionOnly,
    writesFiles: true,
  }),
  entry({
    command: 'dev mark-validated',
    description: 'Metadata-only: record a validation outcome on a session.',
    category: 'dev',
    safetyLevel: SafetyLevel.WritesSessionOnly,
    writesFiles: true,
  }),
  entry({
    command: 'dev diff',
    description: 'Diff two sessions on phase / plans / packet fields.',
    category: 'dev',
    safetyLevel: SafetyLevel.ReadOnly,
  }),
  entry({
    command: 'dev list',
    description: 'List sessions with phase + next action.',
    category: 'dev',
    safetyLevel: SafetyLevel.ReadOnly,
  }),
  entry({
    command: 'dev archive',
    description: 'Move a session to .sharkcraft/sessions-archive/.',
    category: 'dev',
    safetyLevel: SafetyLevel.WritesSessionOnly,
    writesFiles: true,
  }),
  entry({
    command: 'dev clean',
    description: 'Clean old sessions (dry-run by default).',
    category: 'dev',
    safetyLevel: SafetyLevel.WritesSessionOnly,
    writesFiles: true,
    requiresReview: true,
  }),
  entry({
    command: 'dev open',
    description: 'Print the paths inside a session.',
    category: 'dev',
    safetyLevel: SafetyLevel.ReadOnly,
  }),
  entry({
    command: 'dev plans',
    description: 'List plans in a session.',
    category: 'dev',
    safetyLevel: SafetyLevel.ReadOnly,
  }),
  entry({
    command: 'dev reports',
    description: 'List reports in a session.',
    category: 'dev',
    safetyLevel: SafetyLevel.ReadOnly,
  }),
  entry({
    command: 'dev commands',
    description: 'Print copy-pasteable command list for a session.',
    category: 'dev',
    safetyLevel: SafetyLevel.ReadOnly,
  }),
  // `session` (legacy alias) hard-deleted. Use `dev start`.
  entry({
    command: 'onboard',
    description: 'Onboard an existing repo (dry-run by default).',
    category: 'onboarding',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'onboard --write-drafts',
    description: 'Write onboarding drafts under sharkcraft/onboarding/ — never overwrites live config.',
    category: 'onboarding',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
    requiresReview: true,
  }),
  entry({
    command: 'onboard adopt',
    description: 'Classify inferred items into safe-to-adopt / manual-review / low-confidence.',
    category: 'onboarding',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'onboard adopt --write-patch',
    description: 'Write the adoption pseudo-patch under sharkcraft/onboarding/adoption/.',
    category: 'onboarding',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
    requiresReview: true,
  }),
  // Ingest + contradictions + generated + stability + task context
  entry({
    command: 'ingest repository',
    description: 'Build a SharkCraft repository knowledge model (dry-run).',
    category: 'ingestion',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'ingest repository --write-drafts',
    description: 'Write ingestion drafts under sharkcraft/ingestion/ — never overwrites live config.',
    category: 'ingestion',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
    requiresReview: true,
  }),
  // `ingest adopt --write-patch` hard-deleted. Use `onboard adopt --write-patch`.
  entry({
    command: 'ingest diff',
    description: 'Show ingest adoption deltas (safe-append / manual-review / etc.). Read-only.',
    category: 'ingestion',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'ingest status',
    description: 'Report whether ingest drafts / adoption files exist on disk. Read-only.',
    category: 'ingestion',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'ingest report',
    description: 'Render the saved ingest knowledge model in text / markdown / html / json. Read-only.',
    category: 'ingestion',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'ingest clean --write',
    description: 'Remove sharkcraft/ingestion/. Default is --dry-run.',
    category: 'ingestion',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
    requiresReview: true,
  }),
  entry({
    command: 'contradictions',
    description: 'Detect documentation vs code contradictions (missing paths, deprecated CLI usage). Read-only.',
    category: 'ingestion',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'generated report',
    description: 'Classify generated vs hand-written code (@generated, DO NOT EDIT, openapi-generator, …). Read-only.',
    category: 'ingestion',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'generated protect --write-drafts',
    description: 'Write recommended protect rules under sharkcraft/ingestion/. Never overwrites live policies.',
    category: 'ingestion',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
    requiresReview: true,
  }),
  entry({
    command: 'understand-task "<task>"',
    description: 'Task-specific context bundle (intent + relevant rules + risks + next safe command). Read-only unless --save.',
    category: 'task-context',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
    // Overlaps with `shrk task` (machine packet) and `shrk recommend`
    // (human routing). Pointing at `task` as canonical so users who
    // hit this via tab-complete see the canonical machine-pipe form.
    overlapsWith: ['task', 'recommend'],
    preferredCommand: 'shrk task "<task>"',
  }),
  entry({
    command: 'validate-change',
    description: 'Validate a proposed/staged change (boundaries, generated-file edits, missing tests, doc contradictions). Read-only.',
    category: 'task-context',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'context build',
    description: 'Save a task-specific context bundle under .sharkcraft/context/task-contexts/<slug>.json|.md.',
    category: 'task-context',
    safetyLevel: SafetyLevel.WritesSessionOnly,
    writesFiles: true,
  }),
  entry({
    command: 'context refresh',
    description: 'Rebuild the most recently saved task context. Writes only under .sharkcraft/context/.',
    category: 'task-context',
    safetyLevel: SafetyLevel.WritesSessionOnly,
    writesFiles: true,
  }),
  entry({
    command: 'context status',
    description: 'Show the current task context status. Read-only.',
    category: 'task-context',
    safetyLevel: SafetyLevel.ReadOnly,
  }),
  entry({
    command: 'packs list',
    description: 'List discovered packs.',
    category: 'packs',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
    surface: CommandSurface.Common,
  }),
  entry({
    command: 'packs doctor',
    description: 'Validate pack discovery.',
    category: 'packs',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
    surface: CommandSurface.Common,
    taskRole: CommandTaskRole.Diagnose,
  }),
  entry({
    command: 'packs sign',
    description: 'Sign a pack manifest.',
    category: 'packs',
    safetyLevel: SafetyLevel.WritesSource,
    writesFiles: true,
    requiresReview: true,
    surface: CommandSurface.Common,
  }),
  entry({
    command: 'packs signature-status',
    description: 'Pack manifest signature freshness (verified / missing / invalid / stale).',
    category: 'packs',
    safetyLevel: SafetyLevel.ReadOnly,
    surface: CommandSurface.Common,
    taskRole: CommandTaskRole.Validate,
  }),
  entry({
    command: 'packs contributions',
    description: 'Show what each discovered pack contributes (knowledge / rules / templates / boundaries).',
    category: 'packs',
    safetyLevel: SafetyLevel.ReadOnly,
    surface: CommandSurface.Common,
    taskRole: CommandTaskRole.Inspect,
  }),
  entry({
    command: 'packs verify',
    description: 'Verify pack signatures.',
    category: 'packs',
    safetyLevel: SafetyLevel.ReadOnly,
  }),
  entry({
    command: 'packs new',
    description: 'Scaffold a new SharkCraft pack package (dry-run by default).',
    category: 'packs',
    safetyLevel: SafetyLevel.WritesSource,
    writesFiles: true,
    requiresReview: true,
  }),
  entry({
    command: 'packs test',
    description: 'Validate a pack at the given path. Read-only.',
    category: 'packs',
    safetyLevel: SafetyLevel.ReadOnly,
  }),
  // Knowledge authoring preview surface.
  entry({
    command: 'knowledge add',
    description: 'Preview adding a new knowledge entry. Preview-only.',
    category: 'knowledge',
    safetyLevel: SafetyLevel.ReadOnly,
    surface: CommandSurface.Common,
    intendedAudience: [CommandAudience.Agent, CommandAudience.Human, CommandAudience.PackAuthor],
    taskRole: CommandTaskRole.Generate,
  }),
  entry({
    command: 'knowledge update',
    description: 'Preview an incremental update to a knowledge entry. Preview-only.',
    category: 'knowledge',
    safetyLevel: SafetyLevel.ReadOnly,
    surface: CommandSurface.Common,
    intendedAudience: [CommandAudience.Agent, CommandAudience.Human, CommandAudience.PackAuthor],
    taskRole: CommandTaskRole.Generate,
  }),
  entry({
    command: 'knowledge remove',
    description: 'Preview removal of a knowledge entry. Refuses if reverse references exist.',
    category: 'knowledge',
    safetyLevel: SafetyLevel.ReadOnly,
    surface: CommandSurface.Common,
    intendedAudience: [CommandAudience.Agent, CommandAudience.Human, CommandAudience.PackAuthor],
    taskRole: CommandTaskRole.Generate,
  }),
  entry({
    command: 'knowledge lint',
    description: 'Classify knowledge findings (safe stub / needs-human-wording / stale / advisory).',
    category: 'knowledge',
    safetyLevel: SafetyLevel.ReadOnly,
    surface: CommandSurface.Common,
    intendedAudience: [CommandAudience.Agent, CommandAudience.Human, CommandAudience.PackAuthor],
    taskRole: CommandTaskRole.Diagnose,
  }),
  // AST-driven knowledge entry inference. Common surface — closes
  // the authoring loop and is the verb an agent would reach for
  // during normal work.
  entry({
    command: 'knowledge propose',
    description: 'Propose stub knowledge entries for exported top-level constructs that lack coverage. Preview-first.',
    category: 'knowledge',
    safetyLevel: SafetyLevel.ReadOnly,
    surface: CommandSurface.Common,
    intendedAudience: [CommandAudience.Agent, CommandAudience.Human, CommandAudience.PackAuthor],
    taskRole: CommandTaskRole.Generate,
  }),
  // `knowledge author` (dispatcher alias) hard-deleted. Use `knowledge add|update|remove`.
  // Pack asset authoring workflow.
  entry({
    command: 'pack author status',
    description: 'Pack author status — kind-by-kind contribution inventory + pending drafts + signature state.',
    category: 'pack-author',
    safetyLevel: SafetyLevel.ReadOnly,
    surface: CommandSurface.Advanced,
    intendedAudience: [CommandAudience.PackAuthor, CommandAudience.Agent],
    taskRole: CommandTaskRole.Inspect,
  }),
  entry({
    command: 'pack author preview',
    description: 'Pack author preview (knowledge kind implemented; others deferred).',
    category: 'pack-author',
    safetyLevel: SafetyLevel.ReadOnly,
    surface: CommandSurface.Advanced,
    intendedAudience: [CommandAudience.PackAuthor, CommandAudience.Agent],
    taskRole: CommandTaskRole.Generate,
  }),
  entry({
    command: 'pack author pending',
    description: 'Pack pending state — modified files + drafts + signature + provenance + missing-secret hint.',
    category: 'pack-author',
    safetyLevel: SafetyLevel.ReadOnly,
    surface: CommandSurface.Advanced,
    intendedAudience: [CommandAudience.PackAuthor, CommandAudience.Agent],
    taskRole: CommandTaskRole.Diagnose,
  }),
  entry({
    command: 'pack author validate',
    description: 'Recommended post-authoring validation commands. Read-only.',
    category: 'pack-author',
    safetyLevel: SafetyLevel.ReadOnly,
    surface: CommandSurface.Advanced,
    intendedAudience: [CommandAudience.PackAuthor, CommandAudience.Agent],
    taskRole: CommandTaskRole.Validate,
  }),
  // `pack` (legacy alias) hard-deleted.
  // `pack-author <verb>` migrated to `pack author <verb>` (3-level).
  entry({
    command: 'packs pending',
    description: 'Alias for `pack author pending`. Read-only.',
    category: 'packs',
    safetyLevel: SafetyLevel.ReadOnly,
  }),
  // Asset provenance ledger.
  entry({
    command: 'provenance list',
    description: 'List provenance ledger entries (most-recent first).',
    category: 'provenance',
    safetyLevel: SafetyLevel.ReadOnly,
    surface: CommandSurface.Advanced,
    intendedAudience: [CommandAudience.PackAuthor, CommandAudience.Agent, CommandAudience.Human],
    taskRole: CommandTaskRole.Inspect,
  }),
  entry({
    command: 'provenance show',
    description: 'Show all provenance entries for one asset id.',
    category: 'provenance',
    safetyLevel: SafetyLevel.ReadOnly,
    surface: CommandSurface.Advanced,
    intendedAudience: [CommandAudience.PackAuthor, CommandAudience.Agent],
    taskRole: CommandTaskRole.Inspect,
  }),
  entry({
    command: 'provenance report',
    description: 'Summary report of the asset provenance ledger.',
    category: 'provenance',
    safetyLevel: SafetyLevel.ReadOnly,
    surface: CommandSurface.Advanced,
    intendedAudience: [CommandAudience.PackAuthor, CommandAudience.Agent, CommandAudience.Human],
    taskRole: CommandTaskRole.Inspect,
  }),
  entry({
    command: 'presets apply --write',
    description: 'Apply a preset to sharkcraft/ config (writes drafts + may modify config).',
    category: 'presets',
    safetyLevel: SafetyLevel.WritesSource,
    writesFiles: true,
    requiresReview: true,
  }),
  entry({
    command: 'quality',
    description: 'Run the SharkCraft quality gate (doctor / boundaries / coverage / drift / tests / packs).',
    category: 'gates',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
    surface: CommandSurface.Advanced,
    intendedAudience: [CommandAudience.Human, CommandAudience.Ci],
    taskRole: CommandTaskRole.Validate,
  }),
  entry({
    command: 'ci scaffold github-actions',
    description: 'Scaffold a GitHub Actions workflow for SharkCraft (dry-run by default).',
    category: 'gates',
    safetyLevel: SafetyLevel.WritesSource,
    writesFiles: true,
    surface: CommandSurface.Common,
    taskRole: CommandTaskRole.Generate,
  }),
  entry({
    command: 'boundaries list',
    description: 'List all boundary rules.',
    category: 'boundaries',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'boundaries infer',
    description: 'Infer boundary candidates (dry-run by default).',
    category: 'boundaries',
    safetyLevel: SafetyLevel.ReadOnly,
  }),
  entry({
    command: 'boundaries explain',
    description: 'Explain a boundary rule + suggested fix.',
    category: 'boundaries',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'test context',
    description: 'Run context retrieval contract tests.',
    category: 'tests',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'test agent',
    description: 'Run agent task-packet contract tests.',
    category: 'tests',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'test generate context',
    description: 'Generate a context-test draft (dry-run by default).',
    category: 'tests',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
  }),
  entry({
    command: 'test generate agent',
    description: 'Generate an agent-contract-test draft (dry-run by default).',
    category: 'tests',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
  }),
  entry({
    command: 'commands',
    description: 'List all `shrk` commands with safety labels.',
    category: 'meta',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
    surface: CommandSurface.Common,
  }),
  entry({
    command: 'mcp',
    description: 'Start the read-only MCP server.',
    category: 'meta',
    safetyLevel: SafetyLevel.ReadOnly,
  }),
  entry({
    command: 'version',
    description: 'Print the CLI version.',
    category: 'meta',
    safetyLevel: SafetyLevel.ReadOnly,
    surface: CommandSurface.Common,
  }),
  entry({
    command: 'completion',
    description:
      'Print a sourcable shell-completion script for the `shrk` CLI (bash | zsh | fish). Pipe into your shell rc.',
    category: 'meta',
    safetyLevel: SafetyLevel.ReadOnly,
    surface: CommandSurface.Common,
  }),
  entry({
    command: 'explain',
    description: 'Universal explainer: knowledge entry, rule, template, command id, or stderr blob.',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    surface: CommandSurface.Common,
    intendedAudience: [CommandAudience.Human, CommandAudience.Agent],
    taskRole: CommandTaskRole.Explain,
  }),
  // `shrk watch` / `shrk watch integrity` removed.
  // Use the per-command `--watch` flag on `shrk doctor` / `shrk lint` / etc. instead.
  entry({
    command: 'plan',
    description: 'Inspect, review, sign, or verify a saved plan file.',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    surface: CommandSurface.Common,
    taskRole: CommandTaskRole.Review,
  }),
  entry({
    command: 'plan review',
    description: 'Review a saved plan file (read-only).',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    surface: CommandSurface.Common,
    taskRole: CommandTaskRole.Review,
  }),
  // Additive: validate any external plan/spec file against the
  // live workspace. The input file is NEVER modified.
  entry({
    command: 'plan check',
    description:
      'Validate an external plan/spec file against the live workspace. Read-only. Two built-in extractors (sharkcraft.spec/v1, markdown-frontmatter-loose).',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    surface: CommandSurface.Advanced,
    intendedAudience: [CommandAudience.Human, CommandAudience.Agent],
    taskRole: CommandTaskRole.Review,
  }),
  // `shrk grounding "<task>"` — single-call context primer.
  entry({
    command: 'grounding',
    description:
      'Emit task-relevant rules / knowledge / paths / templates / verification IDs as JSON. Read-only; pure composition over the task-packet ranker.',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    surface: CommandSurface.Common,
    intendedAudience: [CommandAudience.Human, CommandAudience.Agent],
    taskRole: CommandTaskRole.Context,
  }),
  // feedback3 — `shrk why <file>`. Closes the dangling promise from
  // ide.command.ts:112 which already suggests this verb.
  entry({
    command: 'why',
    description:
      'Explain the constraints that apply to a file: package / layer, path conventions, rules, boundary rules, related knowledge. Read-only.',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    surface: CommandSurface.Common,
    intendedAudience: [CommandAudience.Human, CommandAudience.Agent],
    taskRole: CommandTaskRole.Inspect,
  }),
  // Three top-level commands that existed without catalog entries.
  // The catalog needs to know about every registered primary verb so
  // `commands doctor` is honest.
  entry({
    command: 'profiles',
    description:
      'List / inspect pack-contributed profiles (migration, conventions, …). Subcommands: list, get, doctor, search.',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
    surface: CommandSurface.Common,
    taskRole: CommandTaskRole.Inspect,
  }),
  entry({
    command: 'conventions',
    description:
      'Generic conventions registry (naming / path / barrel / layout / command / validation / ownership / testing / release / safety). Subcommands: list, get, doctor, check, explain.',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
    surface: CommandSurface.Common,
    taskRole: CommandTaskRole.Inspect,
  }),
  entry({
    command: 'registrations',
    description:
      'Inspect / preview / plan pack-contributed registration hints (downstream registration steps for generated constructs). Subcommands: list, get, doctor, preview, plan.',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
    surface: CommandSurface.Advanced,
    taskRole: CommandTaskRole.Inspect,
  }),
  entry({
    command: 'self-config doctor',
    description: 'Cross-reference integrity for self-config (rule wiring, action hints, verification commands).',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
    surface: CommandSurface.Common,
    taskRole: CommandTaskRole.Diagnose,
  }),
  entry({
    command: 'graph why',
    description: 'Shortest-path explanation between two graph nodes.',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
    surface: CommandSurface.Common,
    taskRole: CommandTaskRole.Explain,
  }),
  entry({
    command: 'presets list',
    description: 'List discovered presets.',
    category: 'packs',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
    surface: CommandSurface.Common,
  }),
  entry({
    command: 'presets get',
    description: 'Show one preset (composition chain, appliesTo, asset counts).',
    category: 'packs',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
    surface: CommandSurface.Common,
  }),
  entry({
    command: 'presets explain',
    description: 'Explain a preset: composition + appliesTo + recommendation rank for current repo.',
    category: 'packs',
    safetyLevel: SafetyLevel.ReadOnly,
    surface: CommandSurface.Common,
    taskRole: CommandTaskRole.Explain,
  }),
  entry({
    command: 'ask',
    description: 'Render a prompt-shaped answer from local knowledge (no AI call).',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
  }),
  entry({
    command: 'smart-context',
    description:
      'Build deterministic context and ask an AI provider to synthesise an enriched brief (default), structured plan (--plan), or two-stage development plan (--ai-plan). Opt-in; defaults to Gemini. CLAUDE.md is auto-included in the seed.',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    taskRole: CommandTaskRole.Context,
  }),
  entry({
    command: 'smart-context plan-ahead',
    description:
      'Batch-generate AI-backed plans for a queue of upcoming tasks and save each under .sharkcraft/smart-context/.',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    taskRole: CommandTaskRole.Context,
  }),
  entry({
    command: 'smart-context list',
    description: 'List saved smart-context entries under .sharkcraft/smart-context/.',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    taskRole: CommandTaskRole.Inspect,
  }),
  entry({
    command: 'smart-context show',
    description: 'Print a saved smart-context entry by slug.',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    taskRole: CommandTaskRole.Inspect,
  }),
  entry({
    command: 'smart-context embeddings-build',
    description:
      'Build or incrementally refresh the semantic file index used by smart-context. Downloads the embedding model on first run.',
    category: 'core',
    safetyLevel: SafetyLevel.WritesSessionOnly,
    taskRole: CommandTaskRole.Context,
  }),
  entry({
    command: 'smart-context embeddings-status',
    description: 'Report semantic index freshness without loading the embedding model.',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    taskRole: CommandTaskRole.Inspect,
  }),
  entry({
    command: 'spike',
    description:
      'Scaffold starter files for a saved smart-context plan\'s recommended MVP. Reads .sharkcraft/smart-context/<slug>.plan.json.',
    category: 'core',
    safetyLevel: SafetyLevel.WritesSource,
    taskRole: CommandTaskRole.Generate,
  }),
  entry({
    command: 'deps-audit',
    description:
      'Compare declared package dependencies (package.json) with actually imported specifiers (graph). Reports missing + unused deps. Read-only.',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    taskRole: CommandTaskRole.Inspect,
  }),
  entry({
    command: 'scaffold-validate',
    description:
      'Validate that the files in a saved generation plan exist on disk and look intact (size envelope + type match). Read-only.',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    taskRole: CommandTaskRole.Validate,
  }),
  entry({
    command: 'move-plan',
    description:
      'Plan a file move: graph-traced importer rewrites, export touch-ups, cross-package warnings, rollback steps. Read-only.',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    taskRole: CommandTaskRole.Generate,
  }),
  entry({
    command: 'watch',
    description:
      'Emit a focused-context packet on stdout JSONL each time the workspace changes. Designed to feed a parallel Claude agent.',
    category: 'core',
    safetyLevel: SafetyLevel.WritesSessionOnly,
    taskRole: CommandTaskRole.Context,
  }),
  entry({
    command: 'watch list',
    description: 'List active shrk-watch daemons (one per task slug).',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    taskRole: CommandTaskRole.Inspect,
  }),
  entry({
    command: 'watch stop',
    description: 'Stop a running shrk-watch daemon by slug.',
    category: 'core',
    safetyLevel: SafetyLevel.WritesSessionOnly,
    taskRole: CommandTaskRole.Config,
  }),
  entry({
    command: 'watch prune',
    description: 'Remove stale shrk-watch manifests whose owning processes are no longer alive.',
    category: 'core',
    safetyLevel: SafetyLevel.WritesSessionOnly,
    taskRole: CommandTaskRole.Config,
  }),
  entry({
    command: 'safety audit',
    description: 'Audit the SharkCraft safety model (commands, MCP, packs, plan signing).',
    category: 'meta',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
    surface: CommandSurface.Primary,
    intendedAudience: [CommandAudience.Human, CommandAudience.Ci],
    taskRole: CommandTaskRole.Validate,
  }),
  entry({
    command: 'commands doctor',
    description: 'Check catalog completeness against the live command registry.',
    category: 'meta',
    safetyLevel: SafetyLevel.ReadOnly,
    surface: CommandSurface.Advanced,
    intendedAudience: [CommandAudience.Maintainer],
    taskRole: CommandTaskRole.Inspect,
  }),
  entry({
    command: 'help',
    description: 'Print help for a command (or all commands).',
    category: 'meta',
    safetyLevel: SafetyLevel.ReadOnly,
    surface: CommandSurface.Common,
  }),
  entry({
    command: 'mcp serve',
    description: 'Start the read-only MCP server (stdio).',
    category: 'meta',
    safetyLevel: SafetyLevel.ReadOnly,
  }),
  entry({
    command: 'export',
    description: 'Export the workspace registries as a portable archive.',
    category: 'core',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
  }),
  entry({
    command: 'import',
    description: 'Import an exported registry archive into the workspace.',
    category: 'core',
    safetyLevel: SafetyLevel.WritesSource,
    writesFiles: true,
    writesSource: true,
    requiresReview: true,
  }),
  entry({
    command: 'onboard adopt status',
    description: 'Adoption state + freshness summary (read-only).',
    category: 'onboarding',
    safetyLevel: SafetyLevel.ReadOnly,
  }),
  entry({
    command: 'onboard adopt regenerate',
    description: 'Regenerate adoption patch + state; archive previous outputs under history/.',
    category: 'onboarding',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
    requiresReview: true,
  }),
  entry({
    command: 'onboard adopt merge-preview',
    description: 'Preview what a manual merge would require. Read-only.',
    category: 'onboarding',
    safetyLevel: SafetyLevel.ReadOnly,
  }),
  entry({
    command: 'onboard adopt check',
    description: 'Validate adoption patch applicability (git apply --check / internal). Read-only.',
    category: 'onboarding',
    safetyLevel: SafetyLevel.ReadOnly,
  }),
  entry({
    command: 'onboard adopt report',
    description: 'Render the adoption report (text|markdown|html|json). --output writes to a file.',
    category: 'onboarding',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
  }),
  entry({
    command: 'infer templates',
    description: 'Inferred template candidates from pack scaffold patterns + optional AST analysis.',
    category: 'onboarding',
    safetyLevel: SafetyLevel.ReadOnly,
  }),
  entry({
    command: 'scaffolds list',
    description: 'List pack-contributed scaffold patterns.',
    category: 'packs',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'scaffolds get',
    description: 'Show one scaffold pattern.',
    category: 'packs',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'scaffolds doctor',
    description: 'Validate scaffold pattern definitions.',
    category: 'packs',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'report adoption',
    description: 'Render adoption report in chosen format (--output writes).',
    category: 'reports',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
  }),
  entry({
    command: 'report session',
    description: 'Render a dev-session report (html|markdown|json).',
    category: 'reports',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
  }),
  entry({
    command: 'report quality',
    description: 'Render the quality report in chosen format.',
    category: 'reports',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
  }),
  entry({
    command: 'report safety',
    description: 'Render the safety audit in chosen format.',
    category: 'reports',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
  }),
  entry({
    command: 'report review',
    description: 'Render a review packet as html|markdown|json.',
    category: 'reports',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
  }),
  entry({
    command: 'report coverage',
    description: 'Render coverage report.',
    category: 'reports',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
  }),
  entry({
    command: 'report drift',
    description: 'Render drift report.',
    category: 'reports',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
  }),
  entry({
    command: 'report graph',
    description: 'Render knowledge graph summary.',
    category: 'reports',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
  }),
  entry({
    command: 'dev open --serve --live',
    description: 'Local SSE-enabled session server (127.0.0.1 by default; refuses non-GET).',
    category: 'dev',
    safetyLevel: SafetyLevel.ReadOnly,
  }),
  // ── R59: dashboard restored, plus shrk stats ──────────────────────────
  entry({
    command: 'dashboard',
    description: 'Start the local read-only dashboard (web UI + API). GET/HEAD only; 127.0.0.1 by default.',
    category: 'dev',
    safetyLevel: SafetyLevel.ReadOnly,
    surface: CommandSurface.Primary,
    intendedAudience: [CommandAudience.Human],
    taskRole: CommandTaskRole.Inspect,
  }),
  entry({
    command: 'dashboard export',
    description: 'Export dashboard-ready JSON files into a directory (defaults to .sharkcraft/dashboard-data).',
    category: 'dev',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
    surface: CommandSurface.Advanced,
  }),
  entry({
    command: 'dashboard diff',
    description: 'Diff two dashboard exports by directory.',
    category: 'dev',
    safetyLevel: SafetyLevel.ReadOnly,
    surface: CommandSurface.Advanced,
  }),
  entry({
    command: 'stats',
    description: 'Repository statistics — per-language file counts, lines of code, bytes, averages, largest files.',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
    surface: CommandSurface.Primary,
    intendedAudience: [CommandAudience.Human, CommandAudience.Ci],
    taskRole: CommandTaskRole.Inspect,
  }),
  entry({
    command: 'compress',
    description:
      'Deterministically compress a blob (file or stdin) to cut tokens — JSON→table, logs/search/diffs→signal. Reversible via `shrk expand`.',
    category: 'core',
    safetyLevel: SafetyLevel.WritesSessionOnly,
    writesFiles: true,
    mcpAvailable: true,
    surface: CommandSurface.Common,
    intendedAudience: [CommandAudience.Agent, CommandAudience.Human],
    taskRole: CommandTaskRole.Context,
  }),
  entry({
    command: 'expand',
    description: 'Retrieve the full original a `shrk compress` run cached, by its `<<ccr:KEY>>` key.',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
    surface: CommandSurface.Common,
    intendedAudience: [CommandAudience.Agent, CommandAudience.Human],
    taskRole: CommandTaskRole.Context,
  }),
  entry({
    command: 'align',
    description:
      'Replace volatile tokens (UUIDs/JWTs/timestamps/hashes) with stable placeholders for KV-cache prefix stability; reversible via `shrk unalign`.',
    category: 'core',
    safetyLevel: SafetyLevel.WritesSessionOnly,
    writesFiles: true,
    mcpAvailable: true,
    surface: CommandSurface.Advanced,
    intendedAudience: [CommandAudience.Agent, CommandAudience.Human],
    taskRole: CommandTaskRole.Context,
  }),
  entry({
    command: 'unalign',
    description: 'Restore the original volatile tokens in aligned text using its `--map`.',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
    surface: CommandSurface.Advanced,
    intendedAudience: [CommandAudience.Agent, CommandAudience.Human],
    taskRole: CommandTaskRole.Context,
  }),
  // ── Backend feature expansion ─────────────────────────────────────────
  entry({
    command: 'bundle create',
    description: 'Create a feature workflow bundle (no source writes).',
    category: 'bundles',
    safetyLevel: SafetyLevel.WritesSessionOnly,
    writesFiles: true,
  }),
  entry({
    command: 'bundle list',
    description: 'List feature workflow bundles.',
    category: 'bundles',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'bundle show',
    description: 'Show a feature workflow bundle.',
    category: 'bundles',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'bundle plan',
    description: 'Plan one or more templates inside a feature bundle.',
    category: 'bundles',
    safetyLevel: SafetyLevel.WritesSessionOnly,
    writesFiles: true,
  }),
  entry({
    command: 'bundle graph',
    description: 'Plan dependency graph for a feature bundle.',
    category: 'bundles',
    safetyLevel: SafetyLevel.ReadOnly,
  }),
  entry({
    command: 'bundle apply-assist',
    description: 'Suggest a safe apply order (no auto-apply).',
    category: 'bundles',
    safetyLevel: SafetyLevel.WritesSessionOnly,
    requiresReview: true,
  }),
  entry({
    command: 'bundle validate',
    description: 'Run scoped validation for a bundle.',
    category: 'bundles',
    safetyLevel: SafetyLevel.ReadOnly,
  }),
  entry({
    command: 'impact',
    description: 'Architecture impact analysis for a task / files / plan / bundle.',
    category: 'analysis',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
    surface: CommandSurface.Primary,
    intendedAudience: [CommandAudience.Human, CommandAudience.Agent],
    taskRole: CommandTaskRole.Inspect,
  }),
  entry({
    command: 'trace',
    description: 'Fuzzy trace — resolve any free-form query against the engine registries.',
    category: 'analysis',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'feedback',
    description: 'Feedback ingestion (ingest|summarize|actions|convert-to-backlog). Read-only.',
    category: 'analysis',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  // `commands suggest` hard-deleted (folded into unknown-command did-you-mean).
  // `commands explain` hard-deleted (folded into `shrk explain`).
  // `doctor watch` removed (use `shrk doctor --watch`).
  entry({
    command: 'knowledge stale-check --watch',
    description: 'Watch flag on stale-check (debounced, --once supported).',
    category: 'analysis',
    safetyLevel: SafetyLevel.ReadOnly,
  }),
  entry({
    command: 'templates drift --watch',
    description: 'Watch flag on template drift (debounced, --once supported).',
    category: 'analysis',
    safetyLevel: SafetyLevel.ReadOnly,
  }),
  entry({
    command: 'test agent --watch',
    description: 'Watch flag on agent contract tests (debounced, --once supported).',
    category: 'tests',
    safetyLevel: SafetyLevel.ReadOnly,
  }),
  // `watch integrity` removed (compose `--watch` on the individual commands).
  entry({
    command: 'fix',
    description: 'Fix preview system — preview-only suggestions for action hints / stale knowledge / template drift.',
    category: 'fixes',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'lint',
    description: 'Unified lint aggregator. Runs knowledge / rules / templates per-kind doctors in one pass. --kind, --strict, --fix-preview, --json.',
    category: 'fixes',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: false,
  }),
  entry({
    command: 'fix list',
    description: 'List supported fix kinds.',
    category: 'fixes',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'fix doctor',
    description: 'Fix-system doctor — counts errors/warnings without writes.',
    category: 'fixes',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'fix preview',
    description: 'Generate fix previews. `--write-preview` writes only under .sharkcraft/fixes/.',
    category: 'fixes',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
    surface: CommandSurface.Common,
    taskRole: CommandTaskRole.Generate,
  }),
  entry({
    command: 'codemod',
    description: 'Codemod-assist (NOT a codemod engine). Inventory + risk grouping + checklist + project-script template. Never rewrites source.',
    category: 'fixes',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
    mcpAvailable: false,
  }),
  // Universal adoption — ecosystem bridges + IDE data surface.
  entry({
    command: 'eslint',
    description: 'ESLint bridge — `eslint scaffold` emits a flat-config snippet that ignores SharkCraft generated paths; `eslint report` re-emits boundary violations in the ESLint result format.',
    category: 'integrations',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
    mcpAvailable: false,
  }),
  entry({
    command: 'biome',
    description: 'Biome bridge — `biome scaffold` emits a minimal biome.json that ignores SharkCraft generated paths. Boundary discipline stays with `shrk check boundaries`.',
    category: 'integrations',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
    mcpAvailable: false,
  }),
  entry({
    command: 'ide',
    description: 'IDE data surface — `ide file <path> --json` returns per-file applicable rules + relevant knowledge + suggested commands as one record. Read-only.',
    category: 'integrations',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: false,
  }),
  entry({
    command: 'rules lint',
    description: 'Lint rules — alias of `rules doctor` with strict defaults. `--fix-preview` materialises smallest-change patches under .sharkcraft/fixes/rules-lint/ (preview only).',
    category: 'quality',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
    mcpAvailable: false,
    surface: CommandSurface.Common,
    taskRole: CommandTaskRole.Validate,
  }),
  entry({
    command: 'coverage scaffolds',
    description: 'Scaffold/template/playbook coverage gap report for a task or domain.',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'changes',
    description: 'Changes summary (--since/--staged/--files). Grouped diff + risk + validation hints.',
    category: 'analysis',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'changes summary',
    description: 'Grouped changes summary.',
    category: 'analysis',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'pr summary',
    description: 'PR summary generator (markdown by default). `--output <file>` writes to disk.',
    category: 'review',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'ci report',
    description: 'CI integrity report aggregator over .sharkcraft/reports. --fail-on error|warning|none.',
    category: 'ci',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
    surface: CommandSurface.Common,
    taskRole: CommandTaskRole.Validate,
  }),
  entry({
    command: 'impact --symbol',
    description: 'Direct symbol impact — uses AST-backed symbol index.',
    category: 'analysis',
    safetyLevel: SafetyLevel.ReadOnly,
  }),
  entry({
    command: 'trace --symbol',
    description: 'Direct symbol trace — uses AST-backed symbol index.',
    category: 'analysis',
    safetyLevel: SafetyLevel.ReadOnly,
  }),
  entry({
    command: 'tests impact',
    description: 'Test impact analysis.',
    category: 'analysis',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'tests suggest',
    description: 'Suggest a test path for a source file.',
    category: 'analysis',
    safetyLevel: SafetyLevel.ReadOnly,
  }),
  entry({
    command: 'tests missing',
    description: 'List missing test files.',
    category: 'analysis',
    safetyLevel: SafetyLevel.ReadOnly,
  }),
  entry({
    command: 'repo areas',
    description: 'Repository area map.',
    category: 'analysis',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'owners list',
    description: 'List ownership rules.',
    category: 'ownership',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'owners match',
    description: 'Match a file against ownership rules.',
    category: 'ownership',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'owners impact',
    description: 'Ownership impact for files / plan / bundle.',
    category: 'ownership',
    safetyLevel: SafetyLevel.ReadOnly,
  }),
  entry({
    command: 'policy list',
    description: 'List policy checks.',
    category: 'policy',
    safetyLevel: SafetyLevel.ReadOnly,
  }),
  entry({
    command: 'policy check',
    description: 'Run the policy engine.',
    category: 'policy',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'git changed',
    description: 'List changed files (read-only git diff).',
    category: 'git',
    safetyLevel: SafetyLevel.ReadOnly,
  }),
  entry({
    command: 'git root',
    description: 'Print the git repo root.',
    category: 'git',
    safetyLevel: SafetyLevel.ReadOnly,
  }),
  entry({
    command: 'git branch',
    description: 'Print the current git branch.',
    category: 'git',
    safetyLevel: SafetyLevel.ReadOnly,
  }),
  entry({
    command: 'git status-summary',
    description: 'Compact git status summary.',
    category: 'git',
    safetyLevel: SafetyLevel.ReadOnly,
  }),
  entry({
    command: 'graph imports',
    description: 'Import graph analysis (cycles/fan-in/out/orphans).',
    category: 'analysis',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
    surface: CommandSurface.Common,
    taskRole: CommandTaskRole.Inspect,
  }),
  entry({
    command: 'templates lint',
    description: 'Lint registered templates.',
    category: 'quality',
    safetyLevel: SafetyLevel.ReadOnly,
  }),
  entry({
    command: 'templates test',
    description: 'Test template rendering with example variables.',
    category: 'quality',
    safetyLevel: SafetyLevel.ReadOnly,
  }),
  entry({
    command: 'boundaries suggest',
    description: 'Suggest fixes for boundary violations.',
    category: 'analysis',
    safetyLevel: SafetyLevel.ReadOnly,
  }),
  entry({
    command: 'export bundle',
    description: 'Export a feature bundle to a folder.',
    category: 'export',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
  }),
  entry({
    command: 'export session',
    description: 'Export a dev session to a folder.',
    category: 'export',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
  }),
  entry({
    command: 'task decompose',
    description: 'Deterministic task decomposition (no AI).',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
  }),
  entry({
    command: 'review packet',
    description: 'Build a review packet (v1 default, --v2 for the enriched format).',
    category: 'review',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
    surface: CommandSurface.Advanced,
    intendedAudience: [CommandAudience.Human, CommandAudience.Agent, CommandAudience.Ci],
    taskRole: CommandTaskRole.Review,
  }),
  entry({
    command: 'ci scaffold gitlab',
    description: 'Scaffold a GitLab CI configuration.',
    category: 'ci',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
  }),
  // `ci scaffold circleci|azure-pipelines` hard-deleted. See docs/ci-providers.md.
  entry({
    command: 'ci scaffold bitbucket',
    description: 'Scaffold a Bitbucket Pipelines configuration.',
    category: 'ci',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
  }),
  // ── Round 11: impact / search / brief / constructs / playbooks / replay ───
  entry({
    command: 'search',
    description:
      'Unified registry search across knowledge, rules, paths, templates, pipelines, presets, packs, boundaries, docs, sessions, bundles, constructs, playbooks. For "what should I do?" prefer `shrk recommend`.',
    category: 'analysis',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
    surface: CommandSurface.Primary,
    intendedAudience: [CommandAudience.Human, CommandAudience.Agent],
    taskRole: CommandTaskRole.Search,
    preferredCommand: 'shrk recommend "<query>"',
    overlapsWith: ['recommend', 'why'],
  }),
  entry({
    command: 'brief',
    description: 'Render a Markdown / JSON agent brief for a task or diff.',
    category: 'analysis',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
    surface: CommandSurface.Primary,
    intendedAudience: [CommandAudience.Human, CommandAudience.Agent],
    taskRole: CommandTaskRole.Context,
  }),
  entry({
    command: 'constructs list',
    description: 'List registered constructs.',
    category: 'analysis',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'constructs get',
    description: 'Show construct details.',
    category: 'analysis',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'constructs trace',
    description: 'Trace files / publicApi / events / tokens of a construct.',
    category: 'analysis',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'constructs api',
    description: 'Show public-API entries for a construct.',
    category: 'analysis',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'constructs events',
    description: 'List events of a construct.',
    category: 'analysis',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'constructs tokens',
    description: 'List tokens contributed by a construct.',
    category: 'analysis',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'constructs facets',
    description: 'List facets of a construct.',
    category: 'analysis',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'constructs search',
    description: 'Search constructs and facets.',
    category: 'analysis',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'playbooks list',
    description: 'List registered playbooks.',
    category: 'analysis',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'playbooks get',
    description: 'Show a playbook.',
    category: 'analysis',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'playbooks recommend',
    description: 'Recommend playbooks for a task.',
    category: 'analysis',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'playbooks runbook',
    description: 'Render a playbook as a structured runbook.',
    category: 'analysis',
    safetyLevel: SafetyLevel.ReadOnly,
  }),
  entry({
    command: 'playbooks brief',
    description: 'Render an agent brief from a playbook.',
    category: 'analysis',
    safetyLevel: SafetyLevel.ReadOnly,
  }),
  entry({
    command: 'bundle replay',
    description: 'Replay apply-audit.log and detect tampering / drift.',
    category: 'bundles',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'bundle apply-assist --resume',
    description: 'Resume an apply-assist run, skipping already-applied plans.',
    category: 'bundles',
    safetyLevel: SafetyLevel.WritesSessionOnly,
    requiresReview: true,
  }),
  entry({
    command: 'policy test',
    description: 'Test policy checks with fixtures or inline input.',
    category: 'policy',
    safetyLevel: SafetyLevel.ReadOnly,
  }),
  entry({
    command: 'policy run',
    description: 'Run all policy checks.',
    category: 'policy',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'report site --manifest',
    description: 'Emit a JSON manifest of the report site pages.',
    category: 'reports',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
    mcpAvailable: true,
  }),
  entry({
    command: 'runtime doctor',
    description: 'Runtime compatibility doctor (Node / Bun version + compat-node summary).',
    category: 'meta',
    safetyLevel: SafetyLevel.ReadOnly,
  }),
  // ── Visualization / authoring / governance ──────────────────────────
  entry({
    command: 'impact --format',
    description: 'Render impact reports as text / markdown / html / json.',
    category: 'analysis',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'report impact',
    description: 'Render a saved impact JSON in the chosen format.',
    category: 'reports',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
  }),
  entry({
    command: 'report site --impact',
    description: 'Embed an impact JSON in the static report site.',
    category: 'reports',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
  }),
  entry({
    command: 'constructs infer',
    description: 'Infer construct candidates from files / conventions / import graph.',
    category: 'analysis',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'constructs infer --write-drafts',
    description: 'Write inferred constructs to sharkcraft/construct-drafts/ (review-only).',
    category: 'analysis',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
    requiresReview: true,
  }),
  entry({
    command: 'playbooks script',
    description: 'Render a playbook as a bash-style preview script (no execution).',
    category: 'analysis',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
    mcpAvailable: true,
  }),
  entry({
    command: 'playbooks preview',
    description: 'Show playbook preview (structured steps + recommendations).',
    category: 'analysis',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'playbooks validate',
    description: 'Validate a playbook against registered templates / pipelines.',
    category: 'analysis',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'policy snapshot',
    description: 'Capture / compare policy snapshots (writes under fixture dirs only).',
    category: 'policy',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
  }),
  entry({
    command: 'policy test --update-snapshot',
    description: 'Update the saved snapshot for a policy fixture.',
    category: 'policy',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
  }),
  entry({
    command: 'brief --chunk',
    description: 'Chunked brief output (00-index + per-section files).',
    category: 'analysis',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
    mcpAvailable: true,
  }),
  entry({
    command: 'search tuning',
    description: 'List or doctor search-tuning entries contributed by packs / local config.',
    category: 'analysis',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'bundle replay --all',
    description: 'Cross-bundle replay across every bundle (read-only).',
    category: 'bundles',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  // ── Adoption, CI gates, demo scaffolds ──────────────────────────────
  entry({
    command: 'impact --graph-format',
    description: 'Emit Mermaid / DOT dependency graph alongside the impact report.',
    category: 'analysis',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'impact graph',
    description: 'Render a Mermaid / DOT graph from a saved impact report.',
    category: 'analysis',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'report impact --include-graph',
    description: 'Embed a Mermaid / DOT graph in the rendered impact report.',
    category: 'reports',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
  }),
  entry({
    command: 'policy snapshot --gate',
    description: 'CI gate for policy snapshots — exits non-zero on drift/missing.',
    category: 'policy',
    safetyLevel: SafetyLevel.ReadOnly,
  }),
  entry({
    command: 'policy snapshot --accept',
    description: 'Rewrite policy snapshots after human review (fixture-only writes).',
    category: 'policy',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
    requiresReview: true,
  }),
  entry({
    command: 'constructs adopt',
    description: 'Classify construct drafts into safe / review / low / covered / conflict.',
    category: 'analysis',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'constructs adopt --write-patch',
    description: 'Write construct-adoption files under construct-drafts/adoption/.',
    category: 'analysis',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
    requiresReview: true,
  }),
  entry({
    command: 'constructs adopt status',
    description: 'Show construct-adoption plan status / age.',
    category: 'analysis',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'constructs adopt review',
    description: 'Render the construct-adoption review as Markdown.',
    category: 'analysis',
    safetyLevel: SafetyLevel.ReadOnly,
  }),
  entry({
    command: 'search tuning explain',
    description: 'Explain how tuning affects a search query.',
    category: 'analysis',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'bundle replay scaffold github-actions',
    description: 'Scaffold a scheduled bundle-replay workflow (dry-run by default).',
    category: 'bundles',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
    requiresReview: true,
  }),
  entry({
    command: 'ci scaffold github-actions --with-impact',
    description: 'CI scaffold v2: include impact-since-main step + artifact upload.',
    category: 'ci',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
  }),
  entry({
    command: 'ci scaffold github-actions --with-report-site',
    description: 'CI scaffold v2: include report site step + artifact upload.',
    category: 'ci',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
  }),
  entry({
    command: 'ci scaffold github-actions --with-bundle-replay',
    description: 'CI scaffold v2: include bundle-replay step + artifact upload.',
    category: 'ci',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
  }),
  entry({
    command: 'packs release-check',
    description: 'Run a deterministic release-readiness check on a pack.',
    category: 'packs',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  // ── Release-grade adoption, release gates, multi-provider CI, demo workflows ──
  entry({
    command: 'onboard adopt diff',
    description: 'Line-level diff of the proposed onboard adoption against live sharkcraft/*.ts.',
    category: 'onboard',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'constructs adopt diff',
    description: 'Line-level diff of the proposed construct adoption against live constructs.ts.',
    category: 'constructs',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'packs doctor --release',
    description: 'Pack doctor with the release-check gate folded into the report.',
    category: 'packs',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'packs doctor --release --strict',
    description: 'Pack doctor + release-check in strict mode (warnings → errors).',
    category: 'packs',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'packs compat',
    description: 'Detect pack backwards-compat issues (helper-missing imports).',
    category: 'packs',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'ci scaffold gitlab --with-quality',
    description: 'Render a GitLab CI scaffold with the quality gate.',
    category: 'ci',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'ci scaffold bitbucket --with-quality',
    description: 'Render a Bitbucket pipeline scaffold with the quality gate.',
    category: 'ci',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'ci scaffold gitlab --with-policy-snapshot-gate',
    description: 'Add the policy-snapshot gate step to the GitLab scaffold.',
    category: 'ci',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'ci scaffold bitbucket --with-policy-snapshot-gate',
    description: 'Add the policy-snapshot gate step to the Bitbucket scaffold.',
    category: 'ci',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'report site --with-impact-graphs',
    description: 'Embed Mermaid + DOT impact graph source into the report site pages.',
    category: 'reports',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
    mcpAvailable: false,
  }),
  // ── Release hardening, compatibility, visual reports, CI security ──────────
  entry({
    command: 'report site --render-impact-graphs',
    description: 'Optionally render impact graphs to SVG via local mmdc/dot (opt-in, runs a subprocess).',
    category: 'reports',
    safetyLevel: SafetyLevel.RunsShell,
    writesFiles: true,
    runsShell: true,
    mcpAvailable: false,
  }),
  entry({
    command: 'impact <input> --graph-format mermaid --graph-output <path> --render-svg',
    description: 'Render an impact graph to SVG via local mmdc/dot (opt-in subprocess).',
    category: 'review',
    safetyLevel: SafetyLevel.RunsShell,
    writesFiles: true,
    runsShell: true,
    mcpAvailable: false,
  }),
  entry({
    command: 'impact graph <impact.json> --render-svg',
    description: 'Render a previously-saved impact graph to SVG (opt-in subprocess).',
    category: 'review',
    safetyLevel: SafetyLevel.RunsShell,
    writesFiles: true,
    runsShell: true,
    mcpAvailable: false,
  }),
  entry({
    command: 'report site --title "<text>" --brand "<text>"',
    description: 'Add a banner/title and brand label to every page of the report site.',
    category: 'reports',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
    mcpAvailable: false,
  }),
  entry({
    command: 'packs compat --consumer-root <path>',
    description: 'Diff a pack\'s @shrkcrft/plugin-api imports against the consumer\'s installed exports.',
    category: 'packs',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'onboard adopt diff --record-checkpoint',
    description: 'Record an adoption checkpoint for the onboard workflow (drafts/targets/diff hashes).',
    category: 'onboard',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
    mcpAvailable: true,
  }),
  entry({
    command: 'constructs adopt diff --record-checkpoint',
    description: 'Record an adoption checkpoint for the construct workflow.',
    category: 'constructs',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
    mcpAvailable: true,
  }),
  entry({
    command: 'bundle diff <a> <b>',
    description: 'Diff two feature bundles (plans, deps, validations, targets). Read-only.',
    category: 'bundles',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'ci permissions <workflow-file>',
    description: 'Audit a CI workflow for write permissions, comment posting, tokens, external actions.',
    category: 'ci',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  // `ci scaffold jenkins|azure` hard-deleted. See docs/ci-providers.md.
  entry({
    command: 'brief "<task>" --chunk --compare-with <dir>',
    description: 'Render a chunked brief and report which sections changed vs a previous brief directory.',
    category: 'briefs',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: false,
  }),
  entry({
    command: 'release readiness',
    description: 'Aggregated release-readiness gate (doctor + coverage + packs + docs + checklist). Read-only.',
    category: 'release',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
    surface: CommandSurface.Advanced,
    intendedAudience: [CommandAudience.Human, CommandAudience.Ci],
    taskRole: CommandTaskRole.Release,
  }),
  entry({
    command: 'release readiness --strict',
    description: 'Strict readiness — escalate warnings to blockers; exit non-zero on any issue.',
    category: 'release',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  // Additions: human entrypoint, governance, smoke harness.
  entry({
    command: 'start-here',
    description: 'Human entry point — 30-second explanation + 5 primary flows + safety pledge.',
    category: 'onboarding',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
    surface: CommandSurface.Advanced,
    intendedAudience: [CommandAudience.Human],
    taskRole: CommandTaskRole.Start,
  }),
  entry({
    command: 'commands primary',
    description: 'Show the curated primary command list.',
    category: 'meta',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
    surface: CommandSurface.Primary,
    intendedAudience: [CommandAudience.Human],
    taskRole: CommandTaskRole.Start,
  }),
  entry({
    command: 'docs check',
    description: 'Verify docs/ and README content.',
    category: 'governance',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'examples check',
    description: 'Verify examples/ tree integrity.',
    category: 'governance',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'self audit',
    description: 'SharkCraft self-dogfood audit. Meaningful inside the SharkCraft repo.',
    category: 'release',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'release smoke',
    description: 'Run a local smoke suite against canonical demo scenarios.',
    category: 'release',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
    runsShell: true,
    mcpAvailable: true,
  }),
  entry({
    command: 'install smoke',
    description: 'Verify the installed CLI surface (shrk version / help / commands primary / runtime doctor).',
    category: 'release',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    runsShell: true,
    mcpAvailable: true,
  }),
  entry({
    command: 'ci permissions --fix-preview',
    description: 'Suggest a least-privilege fix for a CI workflow (never writes).',
    category: 'ci',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'packs compat --dist-aware',
    description: 'Pack compat scan that also reads dist/*.js CJS/ESM export forms.',
    category: 'packs',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'onboard adopt status --max-age-days',
    description: 'Adoption checkpoint status with custom max-age (default 30 days).',
    category: 'onboarding',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'constructs adopt status --max-age-days',
    description: 'Construct adoption checkpoint status with custom max-age.',
    category: 'constructs',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'release readiness --preflight auto',
    description: 'Auto-discover the newest release:preflight summary in .sharkcraft/reports/.',
    category: 'release',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'release readiness --html',
    description: 'Emit the readiness verdict as JS-free HTML.',
    category: 'release',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  // `ci scaffold jenkins|azure --with-release-readiness` hard-deleted with their parents.
  entry({
    command: 'bundle diff (with rename detection)',
    description: 'Bundle diff with probable plan-rename detection.',
    category: 'bundle',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'brief --chunk (with section hashes)',
    description: 'Chunked brief output now also writes section-hashes.json for delta detection.',
    category: 'brief',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
    mcpAvailable: true,
  }),
  // Additions: smoke assertions / matrix / tarball + self-audit run.
  entry({
    command: 'release smoke --assertions',
    description: 'Smoke harness with per-step content assertions (default on).',
    category: 'release',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
    runsShell: true,
    mcpAvailable: true,
  }),
  entry({
    command: 'release smoke --matrix',
    description: 'Run smoke scenarios across multiple repo targets (sharkcraft/dogfood/synthetic/consumer).',
    category: 'release',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
    runsShell: true,
    mcpAvailable: true,
  }),
  entry({
    command: 'install smoke --tarball',
    description: 'Install-smoke that verifies the published npm tarball shape.',
    category: 'release',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
    runsShell: true,
    mcpAvailable: true,
  }),
  entry({
    command: 'self audit --run',
    description: 'Run the bundled checks (commands doctor, runtime doctor, safety audit, packs doctor, demo validate) with timeouts.',
    category: 'release',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    runsShell: true,
    mcpAvailable: true,
  }),
  entry({
    command: 'diagnostics list',
    description: 'List every known SharkCraft failure diagnostic.',
    category: 'meta',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  // `diagnostics get` hard-deleted. Use `shrk explain <code>`.
  entry({
    command: 'commands ux-check',
    description: 'Audit catalog UX — descriptions, safety metadata, alias collisions.',
    category: 'meta',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'report site --pack-compat',
    description: 'Embed a pack compatibility report as a `pack-compat.html` page in the report site.',
    category: 'release',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
    mcpAvailable: true,
  }),
  entry({
    command: 'architecture map',
    description: 'Architecture map v2 — layers, public-API, boundary rules, risks.',
    category: 'analysis',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'orchestrate',
    description: 'Read-only agent orchestration plan (no execution).',
    category: 'agent',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'simulate',
    description: 'Predict what a workflow would do without executing it.',
    category: 'agent',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'feedback rules',
    description: 'List + validate pack-contributed feedback rules. Read-only.',
    category: 'meta',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'reposet init',
    description: 'Preview a reposet starter config (dry-run by default).',
    category: 'meta',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
    mcpAvailable: false,
  }),
  entry({
    command: 'reposet list',
    description: 'List repos in the local reposet config.',
    category: 'meta',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'reposet doctor',
    description: 'Sanity-check the reposet roots exist.',
    category: 'meta',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: false,
  }),
  entry({
    command: 'reposet map',
    description: 'Aggregate map across the reposet.',
    category: 'analysis',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'recommend',
    description:
      'Canonical human entrypoint for "what should I do?" — recommends commands for a query or stderr blob (deterministic, no AI).',
    category: 'agent',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
    surface: CommandSurface.Primary,
    intendedAudience: [CommandAudience.Human],
    taskRole: CommandTaskRole.Start,
    overlapsWith: ['context', 'task', 'search'],
  }),
  // `diagnostics suggest` hard-deleted. Use `shrk explain <stderr>`.
  entry({
    command: 'upgrade check',
    description: 'Check for SharkCraft schema migrations.',
    category: 'meta',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'upgrade plan',
    description: 'Plan a SharkCraft upgrade (alias for `upgrade check --json`).',
    category: 'meta',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: false,
  }),
  entry({
    command: 'safety audit --deep',
    description: 'Deep safety audit (report-site external JS, demo destructive lines, CI permissions).',
    category: 'safety',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
    surface: CommandSurface.Primary,
    intendedAudience: [CommandAudience.Human, CommandAudience.Ci],
    taskRole: CommandTaskRole.Validate,
  }),
  entry({
    command: 'architecture violations',
    description: 'Boundary violations report.',
    category: 'analysis',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'architecture area',
    description: 'Show members of an architecture area.',
    category: 'analysis',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'orchestrate --risk-aware',
    description: 'Risk-aware orchestration plan (folds in boundary/policy/architecture signals).',
    category: 'agent',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  // `commands taxonomy` hard-deleted; the catalog already exposes
  // a `--taxonomy` filter on the parent `commands` command.
  entry({
    command: 'reposet map --parallel',
    description: 'Parallel reposet map with bounded concurrency.',
    category: 'analysis',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: false,
  }),
  entry({
    command: 'risk',
    description: 'Per-task risk report (intent + impact + boundaries + ownership + tests).',
    category: 'agent',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  // Agent contract, plan simulate, memory, heal, agent graph.
  entry({
    command: 'contract',
    description:
      'Build an agent contract for a task. Read-only unless --save (writes only to .sharkcraft/contracts/).',
    category: 'agent',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'plan simulate',
    description: 'Simulate a saved generation plan (v1/v2) without writing source. Read-only.',
    category: 'agent',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
    surface: CommandSurface.Common,
    taskRole: CommandTaskRole.Review,
  }),
  entry({
    command: 'memory build',
    description: 'Build the local repository memory index. Writes only to .sharkcraft/memory/.',
    category: 'agent',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
    mcpAvailable: false,
  }),
  entry({
    command: 'memory report',
    description: 'Render the repository memory report. Read-only.',
    category: 'agent',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'memory risk',
    description: 'Combine task risk with historical memory signals. Read-only.',
    category: 'agent',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'memory files',
    description: 'List historically risky files from the memory index. Read-only.',
    category: 'agent',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'memory diagnostics',
    description: 'List recurring diagnostics from the memory index. Read-only.',
    category: 'agent',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'memory reset',
    description:
      'Reset the local repository memory. Dry-run default; --write deletes only .sharkcraft/memory.',
    category: 'agent',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
    mcpAvailable: false,
  }),
  // `heal from-command|-error|-file|-report` hard-deleted. Use `shrk heal --from <source>`.
  entry({
    command: 'contract check',
    description:
      'Validate an agent contract (gates, plan readiness, forbidden files, public-API touch, risk/memory approval). Read-only.',
    category: 'agent',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'contract approve',
    description:
      'Sign an approval for a contract; writes only to the supplied --output path.',
    category: 'agent',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
    requiresReview: true,
    mcpAvailable: true,
  }),
  entry({
    command: 'contract status',
    description: 'Show contract hash, role, mode, and approval verification. Read-only.',
    category: 'agent',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  // Polyglot languages + memory drift + contract templates.
  entry({
    command: 'languages',
    description:
      'Polyglot language support: detect / commands / deps / tests. Read-only.',
    category: 'polyglot',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'languages detect',
    description: 'Detect language profiles (TS/JS/Java/C#/Python/Go/Rust). Read-only.',
    category: 'polyglot',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'languages commands',
    description: 'Per-language install/test/typecheck/lint/build commands. Read-only.',
    category: 'polyglot',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'languages deps',
    description: 'Polyglot dependency graph (Java/C#/Python/Go/Rust imports). Read-only.',
    category: 'polyglot',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'languages tests',
    description: 'Predict per-language test files impacted by changed source files. Read-only.',
    category: 'polyglot',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'memory diff',
    description: 'Compare two memory snapshots (or one snapshot vs the current index). Read-only.',
    category: 'agent',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'memory drift',
    description:
      'Compare the current memory index against the latest snapshot under .sharkcraft/memory/history/. Read-only.',
    category: 'agent',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'memory snapshots',
    description: 'List archived memory snapshots. Read-only.',
    category: 'agent',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: false,
  }),
  entry({
    command: 'contract template',
    description: 'Reusable agent-contract templates (list/get/render/recommend). Read-only.',
    category: 'agent',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'report language',
    description: 'Combined language profiles + commands + dependency graph report. Read-only.',
    category: 'reports',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: false,
  }),
  // Polyglot enforcement + safe runner + language cache + signed ingest apply.
  entry({
    command: 'languages boundaries',
    description: 'Polyglot boundary enforcement report. Read-only.',
    category: 'polyglot',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'languages run',
    description: 'Plan or execute a per-language test/build/lint command. Dry-run by default; --execute to run; --allow-install to permit install/restore.',
    category: 'polyglot',
    safetyLevel: SafetyLevel.RunsShell,
    runsShell: true,
    requiresReview: true,
    mcpAvailable: true,
  }),
  entry({
    command: 'languages cache',
    description: 'Language profile cache (status / clear). Default dry-run.',
    category: 'polyglot',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'boundaries enforce',
    description: 'Polyglot boundary enforcement (read-only). Exits non-zero on errors.',
    category: 'boundaries',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'check boundaries --polyglot',
    description: 'Combined TS + polyglot boundary check. Read-only.',
    category: 'boundaries',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'check boundaries --changed-only',
    description: 'Boundary check filtered to changes (working tree, --since <ref>, --staged, --files). Read-only.',
    category: 'boundaries',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'boundaries enforce --changed-only',
    description: 'Polyglot boundary enforcement filtered to changes. Read-only.',
    category: 'boundaries',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'architecture violations --changed-only',
    description: 'Architecture violations diff scoped to working-tree changes. Read-only.',
    category: 'boundaries',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'helper list',
    description: 'List available helper plan generators. Read-only.',
    category: 'lifecycle',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'helper get',
    description: 'Show a helper definition. Read-only.',
    category: 'lifecycle',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'helper plan',
    description: 'Generate a plan-only helper plan (dry-run by default).',
    category: 'lifecycle',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'packs dev-status',
    description: 'Pack-author dev status. Read-only.',
    category: 'packs',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'packs watch',
    description: 'Watch pack assets and re-run pack doctor on change. Never auto-signs.',
    category: 'packs',
    safetyLevel: SafetyLevel.RunsShell,
    runsShell: true,
    mcpAvailable: false,
  }),
  entry({
    command: 'check registry-lifecycle',
    description: 'register*/remove* symmetry rule. Read-only.',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'registry lifecycle',
    description: 'register*/remove* symmetry rule (standalone command). Read-only.',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  // `ingest adopt plan|review|apply` hard-deleted. Use `onboard adopt`.
  // Schemas surfaces (catalog coverage).
  entry({
    command: 'schemas list',
    description: 'List hand-written JSON schemas exported by `shrk schemas write`.',
    category: 'schemas',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'schemas get',
    description: 'Print one JSON schema by name.',
    category: 'schemas',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'schemas inventory',
    description:
      'Schema-id inventory: known versions, current, deprecated/back-compat status. Read-only.',
    category: 'schemas',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  entry({
    command: 'schemas write',
    description: 'Write all JSON schemas to a directory.',
    category: 'schemas',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
  }),
  // Preview-first schema emit with INDEX.md + preflight drift check.
  entry({
    command: 'schemas emit',
    description:
      'Emit every JSON schema to disk (default docs/schemas/) with an INDEX.md. Preview-first; --write applies; --check fails on drift.',
    category: 'schemas',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
    surface: CommandSurface.Advanced,
    intendedAudience: [CommandAudience.Human, CommandAudience.PackAuthor],
    taskRole: CommandTaskRole.Diagnose,
  }),
  // Round snapshots + diff verb. Advanced surface — meta-tooling for
  // release engineers, not the default agent flow.
  entry({
    command: 'rounds capture',
    description:
      'Capture a snapshot of the engine surface (commands, MCP tools, docs) at HEAD under .sharkcraft/rounds/<id>/.',
    category: 'meta',
    safetyLevel: SafetyLevel.WritesDraftsOnly,
    writesFiles: true,
    surface: CommandSurface.Advanced,
    intendedAudience: [CommandAudience.Human],
    taskRole: CommandTaskRole.Diagnose,
  }),
  entry({
    command: 'rounds list',
    description: 'List captured round snapshots.',
    category: 'meta',
    safetyLevel: SafetyLevel.ReadOnly,
    surface: CommandSurface.Advanced,
    intendedAudience: [CommandAudience.Human, CommandAudience.Agent],
    taskRole: CommandTaskRole.Inspect,
  }),
  entry({
    command: 'rounds show',
    description: 'Print one captured round snapshot.',
    category: 'meta',
    safetyLevel: SafetyLevel.ReadOnly,
    surface: CommandSurface.Advanced,
    intendedAudience: [CommandAudience.Human, CommandAudience.Agent],
    taskRole: CommandTaskRole.Inspect,
  }),
  entry({
    command: 'diff rounds',
    description:
      'Diff two round snapshots: commands/MCP tools/docs added or removed between two captured rounds.',
    category: 'meta',
    safetyLevel: SafetyLevel.ReadOnly,
    surface: CommandSurface.Advanced,
    intendedAudience: [CommandAudience.Human, CommandAudience.Agent],
    taskRole: CommandTaskRole.Inspect,
  }),
  // Explore a directory (workspace-aware).
  entry({
    command: 'explore',
    description:
      'Explore a directory: area kind, key modules, related commands/MCP tools, tests, conventions, risks. Read-only.',
    category: 'core',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
    surface: CommandSurface.Advanced,
    intendedAudience: [CommandAudience.Human, CommandAudience.Agent],
    taskRole: CommandTaskRole.Inspect,
  }),
  // Round-aware acceptance replay.
  entry({
    command: 'changes acceptance-replay',
    description:
      'Pick previous validation commands to re-run given a change set. Read-only, no shell execution.',
    category: 'analysis',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: true,
  }),
  // Command-surface views.
  entry({
    command: 'commands surface',
    description:
      'Filter the command catalog by surface (primary | common | advanced | machine | internal | legacy).',
    category: 'meta',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: false,
    surface: CommandSurface.Common,
    intendedAudience: [CommandAudience.Human],
    taskRole: CommandTaskRole.Inspect,
  }),
  entry({
    command: 'commands machine',
    description:
      'Show only machine-oriented commands (JSON pipes / agent surfaces).',
    category: 'meta',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: false,
    surface: CommandSurface.Advanced,
    intendedAudience: [CommandAudience.Maintainer, CommandAudience.Agent],
    taskRole: CommandTaskRole.Inspect,
  }),
  entry({
    command: 'commands legacy',
    description:
      'Show only legacy / replaced commands and their replacedBy targets.',
    category: 'meta',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: false,
    surface: CommandSurface.Advanced,
    intendedAudience: [CommandAudience.Maintainer],
    taskRole: CommandTaskRole.Inspect,
  }),
  entry({
    command: 'commands overlaps',
    description:
      'Show overlapping commands with their preferredCommand pointers (or `(none)` when missing).',
    category: 'meta',
    safetyLevel: SafetyLevel.ReadOnly,
    mcpAvailable: false,
    surface: CommandSurface.Common,
    intendedAudience: [CommandAudience.Human, CommandAudience.Maintainer],
    taskRole: CommandTaskRole.Inspect,
  }),
]);

/** Return every canonical command string in the catalog. */
export function listCatalogCommandStrings(): string[] {
  const out = new Set<string>();
  for (const e of COMMAND_CATALOG) {
    const base = `shrk ${e.command}`.replace(/\s+/g, ' ').trim();
    out.add(base);
    // First two tokens are also accepted as a known prefix (e.g. "shrk dev").
    const parts = base.split(' ');
    if (parts.length >= 2) out.add(parts.slice(0, 2).join(' '));
    if (parts.length >= 3) out.add(parts.slice(0, 3).join(' '));
  }
  return [...out].sort();
}

function entry(opts: {
  command: string;
  description: string;
  category: string;
  safetyLevel: SafetyLevel;
  writesFiles?: boolean;
  writesSource?: boolean;
  runsShell?: boolean;
  requiresReview?: boolean;
  mcpAvailable?: boolean;
  aliases?: readonly string[];
  // Surface metadata (all optional; defaults derived in helpers).
  surface?: CommandSurface;
  intendedAudience?: readonly CommandAudience[];
  taskRole?: CommandTaskRole;
  preferredCommand?: string;
  overlapsWith?: readonly string[];
  replacedBy?: string;
  machineOnly?: boolean;
  // Lifecycle metadata.
  lifecycle?: CommandLifecycle;
  deprecatedSince?: string;
  removeAfter?: string;
  reason?: string;
  showInDefaultHelp?: boolean;
  // Explicit tier override.
  tier?: CommandTier;
}): ICommandCatalogEntry {
  const out: ICommandCatalogEntry = {
    command: opts.command,
    description: opts.description,
    category: opts.category,
    safetyLevel: opts.safetyLevel,
    writesFiles: opts.writesFiles ?? false,
    writesSource: opts.writesSource ?? false,
    runsShell: opts.runsShell ?? false,
    requiresReview: opts.requiresReview ?? false,
    mcpAvailable: opts.mcpAvailable ?? false,
    aliases: opts.aliases ?? [],
  };
  if (opts.surface) out.surface = opts.surface;
  if (opts.intendedAudience) out.intendedAudience = opts.intendedAudience;
  if (opts.taskRole) out.taskRole = opts.taskRole;
  if (opts.preferredCommand) out.preferredCommand = opts.preferredCommand;
  if (opts.overlapsWith) out.overlapsWith = opts.overlapsWith;
  if (opts.replacedBy) out.replacedBy = opts.replacedBy;
  if (opts.machineOnly !== undefined) out.machineOnly = opts.machineOnly;
  if (opts.lifecycle) out.lifecycle = opts.lifecycle;
  if (opts.deprecatedSince) out.deprecatedSince = opts.deprecatedSince;
  if (opts.removeAfter) out.removeAfter = opts.removeAfter;
  if (opts.reason) out.reason = opts.reason;
  if (opts.showInDefaultHelp !== undefined) out.showInDefaultHelp = opts.showInDefaultHelp;
  if (opts.tier) out.tier = opts.tier;
  return out;
}

/**
 * Pruning overlay. Maps catalog `command` strings to a hide/deprecate verdict.
 *
 * The overlay is a back-stop for `hidden` verdicts that would be tedious to
 * express as inline `surface: Advanced` on every variant of a parent entry.
 *
 * The export name remains `R46_OVERLAY` for stability — tests and
 * docs still reference it.
 *
 * - `deprecated` entries are treated as `lifecycle: Deprecated` for
 *   the purposes of `commandLifecycle()` / `defaultShowInHelp()`.
 *   They remain executable; the help renderer hides them and the
 *   deprecation banner instructs callers to use the canonical
 *   replacement.
 * - `retired` entries are deprecated + reserved for full removal
 *   after the version listed in `removeAfter`.
 * - `hidden` entries are visible only under `shrk help --all` /
 *   `--advanced`.
 */
export interface IR46OverlayEntry {
  readonly verdict: 'deprecated' | 'retired' | 'hidden';
  readonly replacedBy?: string;
  readonly reason?: string;
  readonly removeAfter?: string;
}

export const R46_OVERLAY: Readonly<Record<string, IR46OverlayEntry>> = Object.freeze({
  // `dashboard serve` overlay removed: command is hard-deleted.
  // release / install smoke + self audit (kept executable for scripts).
  'install smoke': { verdict: 'hidden', reason: 'Publish-flow check; scripts call this directly.' },
  'install smoke --tarball': { verdict: 'hidden', reason: 'Publish-flow check; scripts call this directly.' },
  'release smoke': { verdict: 'hidden', reason: 'Publish-flow check; scripts call this directly.' },
  'release smoke --assertions': { verdict: 'hidden', reason: 'Publish-flow check; scripts call this directly.' },
  'release smoke --matrix': { verdict: 'hidden', reason: 'Publish-flow check; scripts call this directly.' },
  'self audit': { verdict: 'hidden', reason: 'Publish-flow check; scripts call this directly.' },
  'self audit --run': { verdict: 'hidden', reason: 'Publish-flow check; scripts call this directly.' },
  // feedback ingestion (kept executable; rules remain load-bearing).
  'feedback': { verdict: 'hidden', reason: 'Feedback belongs in GitHub issues; rules remain load-bearing.' },
  // catalog meta cleanup — `commands explain` / `commands suggest` hard-deleted.
  'commands legacy': { verdict: 'hidden', reason: 'Internal catalog tooling.' },
  'commands machine': { verdict: 'hidden', reason: 'Internal catalog tooling.' },
  'commands overlaps': { verdict: 'hidden', reason: 'Internal catalog tooling.' },
  'commands primary': { verdict: 'hidden', reason: '`shrk` already lists primary commands.' },
  'commands surface': { verdict: 'hidden', reason: 'Internal catalog tooling.' },
  'commands taxonomy': { verdict: 'hidden', reason: 'Internal catalog tooling.' },
  // aliases retained as catalog-meta entries (the CLI commands themselves were deleted; entry kept where it informs typo-correction).
  'packs pending': { verdict: 'hidden', replacedBy: 'shrk pack author pending', reason: 'Canonical 3-level path is `pack author pending`.' },
  // bundles / sessions / dev / context — `session` hard-deleted.
  'bundle apply-assist': { verdict: 'hidden', reason: 'Advanced apply-assist; agents have native session state.' },
  'bundle apply-assist --resume': { verdict: 'hidden', reason: 'Advanced apply-assist.' },
  'bundle create': { verdict: 'hidden', reason: 'Advanced bundle creation.' },
  'bundle diff <a> <b>': { verdict: 'hidden', reason: 'Bundle inspection is advanced.' },
  'bundle diff (with rename detection)': { verdict: 'hidden', reason: 'Bundle inspection is advanced.' },
  'bundle graph': { verdict: 'hidden', reason: 'Folded into `shrk graph`.' },
  'bundle list': { verdict: 'hidden', reason: 'Bundle namespace is advanced.' },
  'bundle plan': { verdict: 'hidden', reason: 'Bundle namespace is advanced.' },
  'bundle show': { verdict: 'hidden', reason: 'Bundle namespace is advanced.' },
  'context build': { verdict: 'hidden', reason: '`shrk context --task` is canonical.' },
  'context refresh': { verdict: 'hidden', reason: '`shrk context --task` is canonical.' },
  'context status': { verdict: 'hidden', reason: '`shrk context --task` is canonical.' },
  // ingest / generated — `ingest adopt apply|plan|review|--write-patch` hard-deleted.
  'ingest clean --write': { verdict: 'hidden', reason: 'Ingestion stays as advanced.' },
  'ingest diff': { verdict: 'hidden', reason: 'Ingestion stays as advanced.' },
  'ingest report': { verdict: 'hidden', reason: 'Ingestion stays as advanced.' },
  'ingest repository': { verdict: 'hidden', reason: 'Ingestion stays as advanced.' },
  'ingest repository --write-drafts': { verdict: 'hidden', reason: 'Ingestion stays as advanced.' },
  'ingest status': { verdict: 'hidden', reason: 'Ingestion stays as advanced.' },
  'generated protect --write-drafts': { verdict: 'hidden', reason: 'Generated-code report is advanced.' },
  'generated report': { verdict: 'hidden', reason: 'Generated-code report is advanced.' },
  // constructs / playbooks / helpers.
  'constructs adopt': { verdict: 'hidden', reason: 'Constructs adoption is advanced.' },
  'constructs adopt --write-patch': { verdict: 'hidden', reason: 'Constructs adoption is advanced.' },
  'constructs adopt diff': { verdict: 'hidden', reason: 'Constructs adoption is advanced.' },
  'constructs adopt diff --record-checkpoint': { verdict: 'hidden', reason: 'Constructs adoption is advanced.' },
  'constructs adopt review': { verdict: 'hidden', reason: 'Constructs adoption is advanced.' },
  'constructs adopt status': { verdict: 'hidden', reason: 'Constructs adoption is advanced.' },
  'constructs adopt status --max-age-days': { verdict: 'hidden', reason: 'Constructs adoption is advanced.' },
  'constructs api': { verdict: 'hidden', reason: 'Constructs reflection is advanced.' },
  'constructs events': { verdict: 'hidden', reason: 'Constructs reflection is advanced.' },
  'constructs facets': { verdict: 'hidden', reason: 'Constructs reflection is advanced.' },
  'constructs infer': { verdict: 'hidden', reason: 'Constructs inference is advanced.' },
  'constructs infer --write-drafts': { verdict: 'hidden', reason: 'Constructs inference is advanced.' },
  'constructs search': { verdict: 'hidden', replacedBy: 'shrk search', reason: 'Folded into `shrk search`.' },
  'constructs tokens': { verdict: 'hidden', reason: 'Constructs reflection is advanced.' },
  'playbooks brief': { verdict: 'hidden', reason: 'Playbooks advanced.' },
  'playbooks get': { verdict: 'hidden', reason: 'Playbooks advanced.' },
  'playbooks list': { verdict: 'hidden', reason: 'Playbooks advanced.' },
  'playbooks preview': { verdict: 'hidden', reason: 'Playbooks advanced.' },
  'playbooks recommend': { verdict: 'hidden', reason: '`shrk recommend` is canonical.' },
  'playbooks runbook': { verdict: 'hidden', reason: 'Playbooks advanced.' },
  'playbooks script': { verdict: 'hidden', reason: 'Playbooks advanced.' },
  'playbooks validate': { verdict: 'hidden', reason: 'Playbooks advanced.' },
  'helper get': { verdict: 'hidden', reason: 'Helpers advanced.' },
  'helper list': { verdict: 'hidden', reason: 'Helpers advanced.' },
  'helper plan': { verdict: 'hidden', reason: 'Helpers advanced.' },
  // memory.
  'memory diagnostics': { verdict: 'hidden', reason: 'Memory support tools are advanced.' },
  'memory diff': { verdict: 'hidden', reason: 'Memory support tools are advanced.' },
  'memory drift': { verdict: 'hidden', reason: 'Memory support tools are advanced.' },
  'memory files': { verdict: 'hidden', reason: 'Memory support tools are advanced.' },
  'memory risk': { verdict: 'hidden', reason: 'Memory support tools are advanced.' },
  'memory snapshots': { verdict: 'hidden', reason: 'Memory support tools are advanced.' },
  // graph / map.
  'architecture area': { verdict: 'hidden', reason: 'Folded into `shrk graph architecture`.' },
  'repo areas': { verdict: 'hidden', reason: 'Folded into `shrk graph`.' },
  'reposet map': { verdict: 'hidden', reason: 'Reposet is advanced.' },
  'reposet map --parallel': { verdict: 'hidden', reason: 'Reposet is advanced.' },
  // CI scaffold non-flagship providers — `circleci|azure|azure-pipelines|jenkins` (+ variants) hard-deleted.
  // heal / diagnostics — `heal from-*`, `diagnostics get|suggest` hard-deleted.
  'schemas get': { verdict: 'hidden', reason: 'Schema inventory is internal.' },
  'schemas inventory': { verdict: 'hidden', reason: 'Schema inventory is internal.' },
  'schemas list': { verdict: 'hidden', reason: 'Schema inventory is internal.' },
  'schemas write': { verdict: 'hidden', reason: 'Schema inventory is internal.' },
  // knowledge author / pack — both hard-deleted.
  // brief / handoff / review / pr — `handoff` hard-deleted.
  'review render-comment': { verdict: 'hidden', reason: 'Advanced PR rendering.' },
  // polyglot.
  'languages deps': { verdict: 'hidden', reason: 'Polyglot is advisory.' },
  'languages tests': { verdict: 'hidden', reason: 'Polyglot is advisory.' },
  'languages boundaries': { verdict: 'hidden', reason: 'Polyglot is advisory.' },
  'languages cache': { verdict: 'hidden', reason: 'Polyglot is advisory.' },
  'languages run': { verdict: 'hidden', reason: 'Polyglot is advisory.' },
});

/** Look up the pruning overlay for a command. */
export function r46Overlay(command: string): IR46OverlayEntry | undefined {
  return R46_OVERLAY[command];
}

/**
 * Surface resolver. Default is `Advanced` (hidden) so the spine is
 * **opt-in**: only entries that set `surface: Primary | Common` explicitly
 * appear in default help.
 *
 * Without this flip, omitted `surface` fields would inherit Common and the
 * default help would balloon into hundreds of commands. With it, only the
 * curated spine (~32 commands) is visible by default; everything else
 * lands under `shrk commands --all` / `--advanced`.
 */
export function commandSurface(e: ICommandCatalogEntry): CommandSurface {
  if (e.surface) return e.surface;
  if (e.safetyLevel === SafetyLevel.RequiresReview) return CommandSurface.Advanced;
  return CommandSurface.Advanced;
}

/** Default audience: humans, plus agents if `mcpAvailable`. */
export function commandAudience(e: ICommandCatalogEntry): readonly CommandAudience[] {
  if (e.intendedAudience && e.intendedAudience.length > 0) return e.intendedAudience;
  return e.mcpAvailable
    ? [CommandAudience.Human, CommandAudience.Agent]
    : [CommandAudience.Human];
}

/** Task role (or `undefined` when not classified). */
export function commandTaskRole(e: ICommandCatalogEntry): CommandTaskRole | undefined {
  return e.taskRole;
}

/**
 * Lifecycle resolution. Inference order:
 *   1. Explicit `lifecycle` value.
 *   2. `replacedBy` set ⇒ {@link CommandLifecycle.Deprecated}.
 *   3. `surface=Legacy` ⇒ {@link CommandLifecycle.Deprecated}.
 *   4. Otherwise {@link CommandLifecycle.Active}.
 *
 * Aliases (synonyms for canonical verbs) and `Retired` (tombstone)
 * must be set explicitly — they're never inferred.
 */
export function commandLifecycle(e: ICommandCatalogEntry): CommandLifecycle {
  if (e.lifecycle) return e.lifecycle;
  const r46 = R46_OVERLAY[e.command];
  if (r46?.verdict === 'retired') return CommandLifecycle.Retired;
  if (r46?.verdict === 'deprecated') return CommandLifecycle.Deprecated;
  if (e.replacedBy) return CommandLifecycle.Deprecated;
  if (e.surface === CommandSurface.Legacy) return CommandLifecycle.Deprecated;
  return CommandLifecycle.Active;
}

/**
 * The "Primary verbs" allowlist — top-level commands that pay rent in
 * the default help surface. Everything else stays callable but is
 * hidden from `--full-help` and from MCP tool advertising; users find
 * them via `shrk surface list`, `shrk help <cmd>`, or `--full-help`.
 *
 * Picked to cover the canonical agent-flow journeys:
 *   - bootstrap a repo, verify it
 *   - get a brief / context / task packet for an agent
 *   - generate safely (plan → apply → check)
 *   - browse what shrk knows (rules / paths / templates / presets)
 *   - inline the rules into the agent's prompt (export, mcp, dashboard)
 *   - daily operations (review, impact, search, explain, why, surface)
 *
 * Anything not in this set falls back to the legacy
 * surface-tier-based visibility, with deprecated / retired / aliased
 * commands hidden regardless. Adding a verb here is the explicit
 * "this is rent-paying" decision.
 */
const PRIMARY_VERBS_ALLOWLIST: ReadonlySet<string> = new Set([
  // Bootstrap
  'init',
  'doctor',
  'inspect',
  'onboard',
  'version',
  'help',
  'preflight',
  'self-config',
  // Per-task
  'brief',
  'recommend',
  'context',
  'task',
  'coverage',
  'explain',
  'why',
  'search',
  'impact',
  'graph',
  'code-intel',
  'compress',
  'expand',
  // Generate code safely
  'gen',
  'apply',
  'check',
  'quality',
  'plan',
  'fix',
  // Browse / inline
  'knowledge',
  'rules',
  'templates',
  'paths',
  'import',
  'export',
  // Architecture & quality gates
  'drift',
  'safety',
  // Run for an agent
  'mcp',
  'dashboard',
  // Ops
  'surface',
  'presets',
  'review',
  'packs',
  'ci',
  'commands',
]);

function topLevelVerb(command: string): string {
  // Strip leading `--cwd <dir>` / `--<flag>` tokens and angle-bracket
  // placeholders; the canonical first verb is whatever leads.
  const tokens = command.split(/\s+/);
  for (const t of tokens) {
    if (!t) continue;
    if (t.startsWith('--') || t.startsWith('-')) continue;
    if (t.startsWith('<') || t.startsWith('"')) continue;
    return t;
  }
  return command;
}

/**
 * Default-help visibility rule. Honors an explicit
 * {@link ICommandCatalogEntry.showInDefaultHelp} when set; otherwise
 * the {@link PRIMARY_VERBS_ALLOWLIST} gates membership in the visible
 * surface (primary + common entries whose top-level verb pays rent
 * make the cut; everything else is hidden from `--full-help`).
 *
 * Deprecated, retired, aliased commands and anything in the
 * {@link R46_OVERLAY} are always hidden regardless of allowlist
 * membership.
 */
export function defaultShowInHelp(e: ICommandCatalogEntry): boolean {
  if (e.showInDefaultHelp !== undefined) return e.showInDefaultHelp;
  const r46 = R46_OVERLAY[e.command];
  if (r46) return false;
  const lc = commandLifecycle(e);
  if (lc === CommandLifecycle.Deprecated || lc === CommandLifecycle.Retired) return false;
  if (lc === CommandLifecycle.Alias) return false;
  // Allowlist gate — the top-level verb must be one of the ~30
  // rent-paying verbs. Subcommands of an allowlisted verb inherit
  // visibility (so `check boundaries` shows under `check`).
  const verb = topLevelVerb(e.command);
  if (!PRIMARY_VERBS_ALLOWLIST.has(verb)) return false;
  const surface = commandSurface(e);
  return surface === CommandSurface.Primary || surface === CommandSurface.Common;
}

/**
 * Short "Use this when…" line derived from `surface`, `taskRole`,
 * `preferredCommand`, `replacedBy`, and `machineOnly`. Empty string when
 * no metadata-driven hint is available.
 */
export function commandUseWhen(e: ICommandCatalogEntry): string {
  const lc = commandLifecycle(e);
  const r46 = R46_OVERLAY[e.command];
  if (lc === CommandLifecycle.Retired) {
    const dest = e.replacedBy ?? e.preferredCommand ?? r46?.replacedBy;
    const reason = r46?.reason ? ` ${r46.reason}` : '';
    return dest
      ? `Retired — use \`${dest}\` instead.${reason}`.trim()
      : `Retired — no replacement; remove from scripts.${reason}`.trim();
  }
  if (lc === CommandLifecycle.Deprecated) {
    const dest = e.replacedBy ?? e.preferredCommand ?? r46?.replacedBy;
    const reason = e.reason ?? r46?.reason ?? '';
    const suffix = reason ? ` ${reason}` : '';
    if (dest) return `Deprecated — prefer \`${dest}\`.${suffix}`;
    return `Deprecated.${suffix}`.trim();
  }
  if (lc === CommandLifecycle.Alias) {
    const dest = e.replacedBy ?? e.preferredCommand;
    return dest
      ? `Alias for \`${dest}\` — kept for compatibility.`
      : 'Alias — kept for compatibility.';
  }
  if (e.replacedBy) {
    return `Legacy — prefer \`${e.replacedBy}\`.`;
  }
  const surface = commandSurface(e);
  if (e.preferredCommand) {
    if (e.machineOnly || surface === CommandSurface.Machine) {
      return `Machine surface (JSON / pipes). For a human answer run \`${e.preferredCommand}\`.`;
    }
    return `For workflow guidance run \`${e.preferredCommand}\` first.`;
  }
  if (e.machineOnly || surface === CommandSurface.Machine) {
    return 'Machine surface (JSON / pipes).';
  }
  if (e.taskRole === CommandTaskRole.Start) {
    return 'Start here — canonical human entrypoint for "what should I do?".';
  }
  return '';
}

export interface ICommandSafetyMatrixRow {
  command: string;
  category: string;
  readsFiles: boolean;
  writesDrafts: boolean;
  writesSession: boolean;
  writesSource: boolean;
  runsShell: boolean;
  mcpAvailable: boolean;
  requiresReview: boolean;
  safeForCi: boolean;
  safeForMcp: boolean;
}

export function buildCommandSafetyMatrix(): readonly ICommandSafetyMatrixRow[] {
  return COMMAND_CATALOG.map((e) => {
    const writesSession = e.safetyLevel === SafetyLevel.WritesSessionOnly;
    const writesDrafts = e.safetyLevel === SafetyLevel.WritesDraftsOnly;
    const writesSource = e.writesSource || e.safetyLevel === SafetyLevel.WritesSource;
    const runsShell = e.runsShell || e.safetyLevel === SafetyLevel.RunsShell;
    const safeForCi = !writesSource && !runsShell && !e.requiresReview;
    const safeForMcp = e.safetyLevel === SafetyLevel.ReadOnly && e.mcpAvailable;
    return {
      command: e.command,
      category: e.category,
      readsFiles: true,
      writesDrafts,
      writesSession,
      writesSource,
      runsShell,
      mcpAvailable: e.mcpAvailable,
      requiresReview: e.requiresReview,
      safeForCi,
      safeForMcp,
    };
  });
}

export function renderCommandSafetyMatrixMarkdown(
  rows: readonly ICommandSafetyMatrixRow[],
): string {
  const lines: string[] = [];
  lines.push('# SharkCraft command safety matrix');
  lines.push('');
  lines.push('| Command | Category | Reads | Drafts | Session | Source | Shell | MCP | Review | CI-safe | MCP-safe |');
  lines.push('| --- | --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |');
  for (const r of rows) {
    const f = (b: boolean): string => (b ? '✓' : '');
    lines.push(
      `| \`${r.command}\` | ${r.category} | ${f(r.readsFiles)} | ${f(r.writesDrafts)} | ${f(r.writesSession)} | ${f(r.writesSource)} | ${f(r.runsShell)} | ${f(r.mcpAvailable)} | ${f(r.requiresReview)} | ${f(r.safeForCi)} | ${f(r.safeForMcp)} |`,
    );
  }
  return lines.join('\n') + '\n';
}
