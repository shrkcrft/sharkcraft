/**
 * R29 PART 14 — SharkCraft self knowledge entries.
 *
 * Each entry describes one piece of engine-internal knowledge an AI
 * agent (or new contributor) needs to do their work safely. Every
 * entry has structured `references` so `shrk knowledge stale-check`
 * can verify it.
 */

interface IKnowledgeRefLocal {
  kind:
    | 'file'
    | 'directory'
    | 'symbol'
    | 'command'
    | 'template'
    | 'playbook'
    | 'construct'
    | 'helper'
    | 'policy'
    | 'boundary-rule'
    | 'path-convention'
    | 'package'
    | 'url';
  path?: string;
  symbol?: string;
  id?: string;
  command?: string;
  required?: boolean;
  note?: string;
}

interface IKnowledgeEntryLocal {
  id: string;
  title: string;
  type: string;
  priority: string;
  scope: readonly string[];
  tags: readonly string[];
  appliesWhen: readonly string[];
  content: string;
  summary?: string;
  references?: readonly IKnowledgeRefLocal[];
}

function defineKnowledgeEntry(e: IKnowledgeEntryLocal): IKnowledgeEntryLocal {
  return e;
}

export default [
  defineKnowledgeEntry({
    id: 'engine.changed-only-boundaries',
    title: 'Changed-only boundary checking',
    type: 'technical',
    priority: 'high',
    scope: ['boundaries', 'r28', 'r29'],
    tags: ['boundaries', 'changed-only', 'r28'],
    appliesWhen: ['fixing-boundary-issues', 'reviewing-changes'],
    summary:
      'Filters boundary violations to those introduced by the changed-file set — hides 25 legacy violations the agent didn\'t cause.',
    content: [
      '`shrk check boundaries --changed-only` is the headline R28 deliverable.',
      'Resolves changed files via `git diff` (working tree, `--since <ref>`, `--staged`, or `--files a,b,c`) and filters violations to those whose origin file is in the changed set.',
      'Exit code is 0 only if the *included* violations are empty — legacy violations don\'t fail the check.',
      'Backed by the shared `IChangedScopeClassification` (R29) which generalises the model across boundaries / policy / drift.',
    ].join('\n\n'),
    references: [
      { kind: 'file', path: 'packages/inspector/src/boundaries-changed-only.ts', required: true },
      { kind: 'file', path: 'packages/inspector/src/changed-scope.ts', required: true },
      { kind: 'symbol', symbol: 'filterViolationsToChangedScope', path: 'packages/inspector/src/boundaries-changed-only.ts' },
      { kind: 'symbol', symbol: 'classifyChangedScope', path: 'packages/inspector/src/changed-scope.ts' },
      { kind: 'command', command: 'shrk check boundaries --changed-only' },
      { kind: 'command', command: 'shrk policy run --changed-only' },
    ],
  }),
  defineKnowledgeEntry({
    id: 'engine.plugin-lifecycle-profiles',
    title: 'Plugin lifecycle profiles (R32)',
    type: 'technical',
    priority: 'high',
    scope: ['plugins', 'profiles', 'r32'],
    tags: ['plugins', 'lifecycle', 'profile', 'pack', 'r32'],
    appliesWhen: ['renaming-a-plugin', 'removing-a-plugin'],
    summary:
      'Plan-only plugin rename / remove driven by pack-contributed lifecycle profiles. The engine ships zero project-specific paths; profiles describe pluginRoots / barrels / keyTable / registryFiles.',
    content: [
      '`shrk plugin rename <old> <new> --profile <id>` / `shrk plugin remove <name> --profile <id>` emit a `sharkcraft.plugin-lifecycle/v1` plan.',
      'Profiles ship via the pack manifest `pluginLifecycleProfileFiles[]` slot or sharkcraft/plugin-lifecycle-profiles.ts.',
      '`shrk plugin lifecycle profiles|profile|doctor` inspect what is registered.',
      'Folder rename / delete is a manual checklist by default; see folder-ops docs for the optional plan-v2 surface.',
    ].join('\n\n'),
    references: [
      { kind: 'file', path: 'packages/plugin-api/src/plugin-lifecycle-profile.ts', required: true },
      { kind: 'file', path: 'packages/inspector/src/plugin-lifecycle.ts', required: true },
      { kind: 'file', path: 'packages/inspector/src/plugin-lifecycle-profile-registry.ts' },
      { kind: 'file', path: 'packages/cli/src/commands/plugin.command.ts' },
      { kind: 'command', command: 'shrk plugin rename' },
      { kind: 'command', command: 'shrk plugin remove' },
      { kind: 'command', command: 'shrk plugin lifecycle profiles' },
    ],
  }),
  defineKnowledgeEntry({
    id: 'engine.helper-plan-registry',
    title: 'Helper plan registry',
    type: 'technical',
    priority: 'medium',
    scope: ['helpers', 'r28'],
    tags: ['helpers', 'plan', 'r28'],
    appliesWhen: ['adding-a-helper'],
    summary:
      'Helpers emit plan-v2 ops for repeated small edits (add a plugin key, add a barrel export, etc.). Dry-run by default; destructive helpers require human approval.',
    content: [
      '`shrk helper list|get|plan <id>` is the surface.',
      'Schema: sharkcraft.helper-plan/v1.',
      'Helpers never write source — every output is a plan the human applies via `shrk apply`.',
    ].join('\n\n'),
    references: [
      { kind: 'file', path: 'packages/inspector/src/helper-registry.ts', required: true },
      { kind: 'command', command: 'shrk helper list' },
      { kind: 'command', command: 'shrk helper plan' },
    ],
  }),
  defineKnowledgeEntry({
    id: 'engine.registry-lifecycle-rule',
    title: 'Registry lifecycle symmetry rule',
    type: 'rule',
    priority: 'medium',
    scope: ['registry', 'r28'],
    tags: ['registry', 'lifecycle', 'r28'],
    appliesWhen: ['adding-a-registry'],
    summary:
      'Every `registerFoo` must have a matching `removeFoo` / `unregisterFoo` / `clearFoo` — or an explicit `@shrkcrft lifecycle-ignore` annotation.',
    content: [
      '`shrk check registry-lifecycle` (or `shrk registry lifecycle`) scans for register sites and reports missing removers.',
      'Annotate exceptions with `@shrkcrft lifecycle-ignore <reason>` or `@shrkcrft lifecycle-managed-by <name>`.',
    ].join('\n\n'),
    references: [
      { kind: 'file', path: 'packages/inspector/src/registry-lifecycle.ts', required: true },
      { kind: 'command', command: 'shrk check registry-lifecycle' },
    ],
  }),
  defineKnowledgeEntry({
    id: 'engine.pack-watch-dev-status',
    title: 'Pack-author watch + dev-status',
    type: 'technical',
    priority: 'medium',
    scope: ['packs', 'r28'],
    tags: ['packs', 'watch', 'dev', 'r28'],
    appliesWhen: ['authoring-a-pack'],
    summary:
      'Live pack-author workflow. `shrk packs watch` re-runs doctor + commands doctor on change; `shrk packs dev-status` shows signature staleness and contribution counts.',
    content: [
      'Throttle is 300ms by default. Never auto-signs.',
      '`shrk packs test --cases` runs `definePackTest` cases against the task packet builder.',
    ].join('\n\n'),
    references: [
      { kind: 'file', path: 'packages/inspector/src/pack-author-ux.ts' },
      { kind: 'file', path: 'packages/inspector/src/pack-test-runner.ts' },
      { kind: 'command', command: 'shrk packs watch' },
      { kind: 'command', command: 'shrk packs dev-status' },
      { kind: 'command', command: 'shrk packs test' },
    ],
  }),
  defineKnowledgeEntry({
    id: 'engine.project-coupling-migration',
    title: 'Project-coupling migration (R32)',
    type: 'technical',
    priority: 'medium',
    scope: ['migration', 'project-coupling', 'r32'],
    tags: ['migration', 'genericity', 'r32'],
    appliesWhen: ['migrating-project-coupling'],
    summary:
      '`shrk migrate project-coupling audit|plan|report` scans the workspace for project-specific tokens (configurable via --token) and tells you how to externalize them into a pack or sharkcraft config.',
    content: [
      'Default scan looks across packages/, sharkcraft/, and docs/.',
      'Each finding gets a recommended externalization target: pack contribution, sharkcraft config, profile, fixture-only, or docs example.',
      'The migration helper is dry-run only; it never writes.',
    ].join('\n\n'),
    references: [
      { kind: 'command', command: 'shrk migrate project-coupling audit' },
      { kind: 'command', command: 'shrk migrate project-coupling plan' },
      { kind: 'command', command: 'shrk migrate project-coupling report' },
    ],
  }),
  defineKnowledgeEntry({
    id: 'engine.language-tooling',
    title: 'Polyglot language tooling',
    type: 'technical',
    priority: 'medium',
    scope: ['languages', 'r27', 'r28'],
    tags: ['polyglot', 'languages', 'r27'],
    appliesWhen: ['adding-polyglot-support', 'fixing-language-detection'],
    summary:
      'Language detection, command inference, dependency scanning, test impact. R28 added a runner allowlist (`sharkcraft/runner.allowlist.json`).',
    content: [
      '`shrk languages run` honours the allow/deny policy; built-in deny patterns cannot be bypassed.',
      '`shrk languages runner config` to inspect / edit allowlist.',
      '`shrk languages run --explain-policy <cmd>` explains why a command is allowed/denied.',
    ].join('\n\n'),
    references: [
      { kind: 'directory', path: 'packages/inspector/src/languages' },
      { kind: 'symbol', symbol: 'getLanguageRunnerPolicy', path: 'packages/inspector/src/languages/language-runner.ts' },
      { kind: 'command', command: 'shrk languages run' },
    ],
  }),
  defineKnowledgeEntry({
    id: 'engine.contract-gates',
    title: 'Contract gates (R24)',
    type: 'rule',
    priority: 'medium',
    scope: ['contracts', 'r24'],
    tags: ['contracts', 'gates', 'r24'],
    appliesWhen: ['gating-apply-on-approval'],
    summary:
      'Contract gates are opt-in but strict — when active, `shrk apply --contract <id>` requires a fresh approval.',
    content: [
      'See ADR: contract-gates-are-opt-in.',
      '`shrk contract check / approve / status` is the surface.',
    ].join('\n\n'),
    references: [
      { kind: 'file', path: 'packages/inspector/src/agent-contract-gate.ts', required: true },
      { kind: 'command', command: 'shrk contract' },
    ],
  }),
  defineKnowledgeEntry({
    id: 'engine.memory-drift',
    title: 'Memory drift detection',
    type: 'technical',
    priority: 'low',
    scope: ['memory', 'r25'],
    tags: ['memory', 'drift', 'r25'],
    appliesWhen: ['inspecting-history'],
    summary:
      'Local repo-memory tracks historical risk signals. `shrk memory drift` compares the live index with the latest snapshot.',
    content: [
      '`shrk memory build` rebuilds the index.',
      '`shrk memory drift` shows what changed since the last snapshot.',
      'See ADR: memory-is-local-only.',
    ].join('\n\n'),
    references: [
      { kind: 'directory', path: 'packages/inspector/src' },
      { kind: 'symbol', symbol: 'loadRepositoryMemory', path: 'packages/inspector/src/repo-memory.ts' },
      { kind: 'command', command: 'shrk memory build' },
      { kind: 'command', command: 'shrk memory drift' },
    ],
  }),
  defineKnowledgeEntry({
    id: 'engine.plan-simulation-diff',
    title: 'Plan simulation diff',
    type: 'technical',
    priority: 'medium',
    scope: ['plan', 'r23'],
    tags: ['plan', 'simulation', 'r23'],
    appliesWhen: ['reviewing-a-plan'],
    summary:
      '`shrk plan simulate <plan.json>` shows the virtual final content of each file plus gate verdicts (boundary, policy, impact, tests).',
    content: [
      'Read-only — never executes the plan.',
      'Useful before `shrk apply` to see the diff a reviewer would see.',
    ].join('\n\n'),
    references: [
      { kind: 'file', path: 'packages/inspector/src/plan-simulation.ts', required: true },
      { kind: 'command', command: 'shrk plan simulate' },
    ],
  }),
  defineKnowledgeEntry({
    id: 'engine.execution-graph',
    title: 'Agent execution graph',
    type: 'technical',
    priority: 'low',
    scope: ['agent', 'r23'],
    tags: ['agent', 'graph', 'r23'],
    appliesWhen: ['building-agent-orchestration'],
    summary:
      '`shrk agent graph <task>` builds a task → intent → risk → contract → constructs → plans → gates → validation graph.',
    content: [
      'Read-only orchestration plan — no execution.',
    ].join('\n\n'),
    references: [
      { kind: 'file', path: 'packages/inspector/src/execution-graph.ts' },
      { kind: 'command', command: 'shrk agent graph' },
    ],
  }),
  defineKnowledgeEntry({
    id: 'engine.fuzzy-trace-impact',
    title: 'Fuzzy trace / impact (R29)',
    type: 'technical',
    priority: 'medium',
    scope: ['trace', 'impact', 'r29'],
    tags: ['trace', 'impact', 'r29', 'fuzzy'],
    appliesWhen: ['exploring-the-codebase'],
    summary:
      '`shrk trace <query>` resolves any free-form query (file, construct, symbol, plugin key, helper, template) and prints structured trace output.',
    content: [
      'Falls back to alternatives when the best match is low-confidence.',
      'Pair with `shrk impact <file>` for transitive impact.',
    ].join('\n\n'),
    references: [
      { kind: 'file', path: 'packages/inspector/src/query-resolver.ts', required: true },
      { kind: 'symbol', symbol: 'resolveQuery', path: 'packages/inspector/src/query-resolver.ts' },
      { kind: 'command', command: 'shrk trace' },
      { kind: 'command', command: 'shrk impact' },
    ],
  }),
  defineKnowledgeEntry({
    id: 'engine.knowledge-stale-check',
    title: 'Knowledge stale-check (R29)',
    type: 'technical',
    priority: 'high',
    scope: ['knowledge', 'r29'],
    tags: ['knowledge', 'stale', 'r29'],
    appliesWhen: ['verifying-knowledge'],
    summary:
      '`shrk knowledge stale-check` verifies references[] and anchors[] against the workspace. No network, no AI.',
    content: [
      'See ADR: knowledge-is-verifiable-not-tribal.',
      'Pair with `shrk knowledge rename-symbol|rename-file` for advisory updates.',
    ].join('\n\n'),
    references: [
      { kind: 'file', path: 'packages/inspector/src/knowledge-stale.ts', required: true },
      { kind: 'symbol', symbol: 'buildKnowledgeStaleReport', path: 'packages/inspector/src/knowledge-stale.ts' },
      { kind: 'command', command: 'shrk knowledge stale-check' },
    ],
  }),
  defineKnowledgeEntry({
    id: 'engine.template-drift',
    title: 'Template drift verification (R29)',
    type: 'technical',
    priority: 'high',
    scope: ['templates', 'r29'],
    tags: ['templates', 'drift', 'r29'],
    appliesWhen: ['verifying-templates', 'releasing-a-pack'],
    summary:
      '`shrk templates drift` verifies templates against path conventions, forbidden legacy paths, missing barrels, missing anchors, unresolved related ids.',
    content: [
      'See ADR: template-drift-checks-before-trust.',
      'Pass `--template <id>` or `--pack <packId>` to scope the check.',
    ].join('\n\n'),
    references: [
      { kind: 'file', path: 'packages/inspector/src/template-drift.ts', required: true },
      { kind: 'symbol', symbol: 'buildTemplateDriftReport', path: 'packages/inspector/src/template-drift.ts' },
      { kind: 'command', command: 'shrk templates drift' },
    ],
  }),
  defineKnowledgeEntry({
    id: 'engine.doctor-suppression',
    title: 'Doctor suppression (R29)',
    type: 'technical',
    priority: 'medium',
    scope: ['doctor', 'r29'],
    tags: ['doctor', 'suppression', 'r29'],
    appliesWhen: ['quieting-noisy-warnings'],
    summary:
      '`shrk doctor --focus errors,warnings-new`, `--hide action-hint-quality`, `--quiet-known` plus `shrk doctor suppress` / `suppressions list|check`.',
    content: [
      'Suppressions live in `sharkcraft/doctor.suppressions.json`.',
      'Suppressed warnings are counted, not deleted. Errors are NOT suppressed unless `allowError: true`.',
      'Expired suppressions surface as a warning.',
    ].join('\n\n'),
    references: [
      { kind: 'file', path: 'packages/inspector/src/doctor-suppressions.ts', required: true },
      { kind: 'symbol', symbol: 'filterDoctorResult', path: 'packages/inspector/src/doctor-suppressions.ts' },
      { kind: 'command', command: 'shrk doctor --quiet-known' },
    ],
  }),
  // ─────────────────────────────────────────────────────────────────────
  // R30 PART 10 — new self-knowledge entries.
  // ─────────────────────────────────────────────────────────────────────
  defineKnowledgeEntry({
    id: 'engine.fuzzy-impact',
    title: 'Fuzzy impact (R30)',
    type: 'technical',
    priority: 'high',
    scope: ['impact', 'r30'],
    tags: ['impact', 'fuzzy', 'r30'],
    appliesWhen: ['investigating-impact', 'tracing-a-construct'],
    summary:
      '`shrk impact <query>` accepts the same fuzzy queries as `shrk trace`. `--resolve-only`, `--explain-resolution`, `--no-resolve` flags. Read-only.',
    content: [
      'Auto-runs impact only on exact / high confidence. Surfaces alternatives otherwise.',
      'Resolution sources: file, construct, plugin-key, symbol, template, helper, playbook, knowledge, command.',
      'Construct/symbol/plugin-key → files come from the construct registry (warm via `warmConstructCache`).',
    ].join('\n\n'),
    references: [
      { kind: 'file', path: 'packages/inspector/src/fuzzy-impact.ts', required: true },
      { kind: 'symbol', symbol: 'resolveFuzzyImpact', path: 'packages/inspector/src/fuzzy-impact.ts' },
      { kind: 'command', command: 'shrk impact <query>' },
      { kind: 'command', command: 'shrk impact <query> --resolve-only' },
    ],
  }),
  defineKnowledgeEntry({
    id: 'engine.agent-test-strict-expectations',
    title: 'Strict agent test expectations (R30)',
    type: 'technical',
    priority: 'high',
    scope: ['agent-tests', 'r30'],
    tags: ['agent-tests', 'ranker', 'r30'],
    appliesWhen: ['running-agent-tests', 'catching-ranker-drift'],
    summary:
      'IAgentContractTest gains expectedHelpers, expectedPlaybooks, expectedPolicies, expectedConstructs, expectedCommands, expectedKnowledge, mustNotInclude, minConfidence.',
    content: [
      'Async loader `loadAgentContractRegistries` pre-loads policy / playbook / construct ids so the sync runner can evaluate strict checks accurately.',
      'mustNotInclude catches the "ranker started surfacing the wrong thing" class of drift.',
    ].join('\n\n'),
    references: [
      { kind: 'file', path: 'packages/inspector/src/test-runner.ts', required: true },
      { kind: 'file', path: 'packages/inspector/src/test-definitions.ts' },
      { kind: 'symbol', symbol: 'loadAgentContractRegistries', path: 'packages/inspector/src/test-runner.ts' },
      { kind: 'command', command: 'shrk test agent' },
    ],
  }),
  defineKnowledgeEntry({
    id: 'engine.knowledge-stale-ci-gate',
    title: 'Knowledge stale-check CI gate (R30)',
    type: 'technical',
    priority: 'high',
    scope: ['knowledge', 'ci', 'r30'],
    tags: ['knowledge', 'ci', 'stale-check', 'r30'],
    appliesWhen: ['enabling-ci-integrity'],
    summary:
      '`shrk knowledge stale-check` adds --ci / --strict / --fail-on / --baseline / --report / --format. Local mode stays non-blocking unless flags are passed.',
    content: [
      '`--ci` blocks on required-true reference failures. `--strict` blocks on any required failure.',
      '`--baseline <file>` computes new-stale / new-missing / resolved diffs against a prior run.',
      'Wires into `shrk release readiness --with-knowledge-check` and respects sharkcraft.config.ts knowledgeCheck.{enabled,strict,failOn}.',
    ].join('\n\n'),
    references: [
      { kind: 'file', path: 'packages/inspector/src/knowledge-stale.ts', required: true },
      { kind: 'file', path: 'packages/cli/src/commands/knowledge.command.ts' },
      { kind: 'command', command: 'shrk knowledge stale-check --ci' },
      { kind: 'command', command: 'shrk release readiness --with-knowledge-check' },
    ],
  }),
  defineKnowledgeEntry({
    id: 'engine.ast-backed-symbol-verification',
    title: 'AST-backed symbol verification (R30)',
    type: 'technical',
    priority: 'high',
    scope: ['knowledge', 'symbol', 'r30'],
    tags: ['knowledge', 'ast', 'symbol', 'r30'],
    appliesWhen: ['verifying-symbol-references'],
    summary:
      '`packages/inspector/src/symbol-index.ts` uses the TypeScript compiler (`createSourceFile`) to parse single files and resolve symbols as exact-export / exact-local / exact-reexport / probable-text / missing.',
    content: [
      'No whole-program type-checking. No new dependencies — typescript is already present.',
      'Falls back to the R29 text-scan when the file cannot be parsed.',
      'Wired into knowledge-stale.ts; available standalone via `resolveSymbolInFile`.',
    ].join('\n\n'),
    references: [
      { kind: 'file', path: 'packages/inspector/src/symbol-index.ts', required: true },
      { kind: 'symbol', symbol: 'buildSymbolIndex', path: 'packages/inspector/src/symbol-index.ts' },
      { kind: 'symbol', symbol: 'resolveSymbolInFile', path: 'packages/inspector/src/symbol-index.ts' },
    ],
  }),
  defineKnowledgeEntry({
    id: 'engine.template-drift-noise-control',
    title: 'Template drift noise control (R30)',
    type: 'technical',
    priority: 'medium',
    scope: ['templates', 'r30'],
    tags: ['templates', 'drift', 'noise', 'r30'],
    appliesWhen: ['tuning-drift-output'],
    summary:
      '`shrk templates drift` adds --min-severity, --hide, --strict, --ci, --format text|markdown|html|json, --report, --output.',
    content: [
      'Severity-rank filter drops findings below the chosen threshold.',
      '--strict promotes warning → error for exit-code purposes only.',
      '--ci writes structured payload; exit is non-zero on errors (and on warnings when --strict is also set).',
    ].join('\n\n'),
    references: [
      { kind: 'file', path: 'packages/cli/src/commands/templates.command.ts' },
      { kind: 'command', command: 'shrk templates drift --min-severity warning' },
      { kind: 'command', command: 'shrk templates drift --ci' },
    ],
  }),
  defineKnowledgeEntry({
    id: 'engine.feedback-rules-pack-extensible',
    title: 'Pack-extensible feedback rules (R30)',
    type: 'technical',
    priority: 'medium',
    scope: ['feedback', 'r30'],
    tags: ['feedback', 'rules', 'r30'],
    appliesWhen: ['adding-feedback-categorisation'],
    summary:
      '`IFeedbackRule` (schema sharkcraft.feedback-rule/v1) loaded from sharkcraft/feedback-rules.ts + pack feedbackRuleFiles[]. CLI: `shrk feedback rules list|doctor`, `shrk feedback ingest <file> --with-pack-rules`.',
    content: [
      'Built-in KEYWORD_RULES still apply first; pack rules supplement.',
      'Compile uses keywords/phrases/regexes — invalid regex strings are skipped silently.',
      'doctor validates: missing id / no fragments / no title / no targetArea / no suggested actions.',
    ].join('\n\n'),
    references: [
      { kind: 'file', path: 'packages/inspector/src/feedback-ingestion.ts', required: true },
      { kind: 'file', path: 'sharkcraft/feedback-rules.ts' },
      { kind: 'symbol', symbol: 'loadFeedbackRules', path: 'packages/inspector/src/feedback-ingestion.ts' },
      { kind: 'command', command: 'shrk feedback rules list' },
      { kind: 'command', command: 'shrk feedback rules doctor' },
    ],
  }),
  defineKnowledgeEntry({
    id: 'engine.ts-decisions-loader',
    title: 'TypeScript decisions loader (R30)',
    type: 'technical',
    priority: 'medium',
    scope: ['decisions', 'r30'],
    tags: ['decisions', 'adr', 'r30'],
    appliesWhen: ['adding-typed-decisions'],
    summary:
      '`loadTsDecisions` reads sharkcraft/decisions.ts + pack decisionFiles[]. Markdown ADRs remain primary; TS entries fold in via cache.',
    content: [
      '`shrk decisions list` warms the TS cache, then lists both sources. Duplicates skip with markdown winning.',
      '`shrk decisions doctor` validates id uniqueness + presence of Context/Decision/Consequences.',
    ].join('\n\n'),
    references: [
      { kind: 'file', path: 'packages/inspector/src/decision-records.ts', required: true },
      { kind: 'file', path: 'sharkcraft/decisions.ts' },
      { kind: 'symbol', symbol: 'loadTsDecisions', path: 'packages/inspector/src/decision-records.ts' },
      { kind: 'command', command: 'shrk decisions doctor' },
    ],
  }),
  defineKnowledgeEntry({
    id: 'engine.ci-integrity-gates',
    title: 'CI scaffold integrity gates (R30)',
    type: 'technical',
    priority: 'medium',
    scope: ['ci', 'r30'],
    tags: ['ci', 'scaffold', 'integrity', 'r30'],
    appliesWhen: ['wiring-ci-checks'],
    summary:
      '`shrk ci scaffold <provider> --with-knowledge-check --with-template-drift --with-integrity` adds the R29/R30 integrity gates to the scaffold.',
    content: [
      'Each gate writes JSON under `.sharkcraft/reports/` so artifact uploads stay symmetric.',
      'Default behaviour unchanged — flags are explicit opt-in per safety policy.',
    ].join('\n\n'),
    references: [
      { kind: 'file', path: 'packages/cli/src/commands/ci.command.ts' },
      { kind: 'command', command: 'shrk ci scaffold github-actions --with-integrity' },
    ],
  }),
  // ── R31 entries ─────────────────────────────────────────────────────
  defineKnowledgeEntry({
    id: 'engine.ranker-why',
    title: 'Ranker explainability — `get_ranker_explanation` / `get_ranker_why_not` (R31; CLI surface removed in R46)',
    type: 'technical',
    priority: 'high',
    scope: ['ranker', 'explainability', 'r31'],
    tags: ['ranker', 'explainability', 'r31'],
    appliesWhen: ['debug-ranker', 'explain-task-result'],
    summary:
      'Read-only MCP tools `get_ranker_explanation` / `get_ranker_why_not` answer "why was X included / not included for task Y?" without writing an agent test. (R46 removed the `shrk why` / `shrk why-not` CLI; the inspector library remains.)',
    content: [
      'Reports include matched/missing signals, score, rank, threshold, outranked-by, search-tuning trace, and suggested metadata fixes.',
      'For missing ids, the report returns nearestIds + suggested commands. The read-only MCP tools `get_ranker_explanation` and `get_ranker_why_not` are the canonical surfaces (no CLI equivalent after R46).',
    ].join('\n\n'),
    references: [
      { kind: 'file', path: 'packages/inspector/src/ranker-explainability.ts', required: true },
      { kind: 'symbol', symbol: 'explainRankerDecision', path: 'packages/inspector/src/ranker-explainability.ts', required: true },
      { kind: 'file', path: 'packages/mcp-server/src/tools/r31-ranker-explain.tool.ts' },
    ],
  }),
  defineKnowledgeEntry({
    id: 'engine.command-discovery',
    title: 'Command discovery + did-you-mean (R31)',
    type: 'technical',
    priority: 'high',
    scope: ['cli', 'discovery', 'r31'],
    tags: ['commands', 'discovery', 'did-you-mean', 'r31'],
    appliesWhen: ['unknown-command', 'find-command'],
    summary:
      '`shrk commands suggest "<partial>"`, `shrk commands explain "<cmd>"` and unknown-subcommand did-you-mean hints — typo-tolerant matching over the catalog.',
    content: [
      'Fuzzy matching is deterministic (Levenshtein + token-fragment scoring). Suggestions include safety level and MCP availability. MCP tools: `suggest_commands`, `search_commands`, `explain_command`.',
    ].join('\n\n'),
    references: [
      { kind: 'file', path: 'packages/inspector/src/command-suggester.ts', required: true },
      { kind: 'symbol', symbol: 'suggestCommands', path: 'packages/inspector/src/command-suggester.ts', required: true },
      { kind: 'symbol', symbol: 'suggestDidYouMean', path: 'packages/inspector/src/command-suggester.ts', required: true },
      { kind: 'command', command: 'shrk commands suggest "knowlege"' },
    ],
  }),
  defineKnowledgeEntry({
    id: 'engine.watch-loops',
    title: 'Watch loops (R31)',
    type: 'technical',
    priority: 'medium',
    scope: ['watch', 'r31'],
    tags: ['watch', 'doctor', 'stale', 'drift', 'r31'],
    appliesWhen: ['active-development'],
    summary:
      '`shrk doctor watch`, `--watch` flag on stale-check / templates drift / test agent, and `shrk watch integrity` combine doctor + stale + drift + agent tests in one loop.',
    content: [
      'Debounced fs.watch (default 300ms). `--once` runs a single snapshot and exits. Linux fallback to non-recursive watch when recursive is unsupported.',
    ].join('\n\n'),
    references: [
      { kind: 'file', path: 'packages/cli/src/output/watch-loop.ts', required: true },
      { kind: 'symbol', symbol: 'maybeRunInWatchMode', path: 'packages/cli/src/output/watch-loop.ts', required: true },
      { kind: 'command', command: 'shrk watch integrity --once' },
    ],
  }),
  defineKnowledgeEntry({
    id: 'engine.fix-preview',
    title: 'Fix preview system (R31)',
    type: 'technical',
    priority: 'medium',
    scope: ['fixes', 'r31'],
    tags: ['fix', 'preview', 'r31'],
    appliesWhen: ['preview-fix', 'resolve-doctor-warning'],
    summary:
      '`shrk fix list|doctor|preview` previews fixes for action hints / stale knowledge / template drift. Preview-only by default; `--write-preview` writes only under `.sharkcraft/fixes/`.',
    content: [
      'Generated action-hint bodies are explicitly stubbed with `needs-human-fill` markers. Doctor continues to warn until the human fills them. MCP tools: `preview_fix`, `list_fix_kinds`.',
    ].join('\n\n'),
    references: [
      { kind: 'file', path: 'packages/inspector/src/fix-preview.ts', required: true },
      { kind: 'file', path: 'packages/cli/src/commands/fix.command.ts', required: true },
      { kind: 'symbol', symbol: 'buildFixPreview', path: 'packages/inspector/src/fix-preview.ts', required: true },
      { kind: 'command', command: 'shrk fix preview --action-hints' },
    ],
  }),
  defineKnowledgeEntry({
    id: 'engine.scaffold-coverage',
    title: 'Scaffold coverage gap reporting (R31)',
    type: 'technical',
    priority: 'medium',
    scope: ['coverage', 'r31'],
    tags: ['scaffold', 'coverage', 'r31', 'gaps'],
    appliesWhen: ['discover-missing-scaffolds'],
    summary:
      '`shrk coverage scaffolds --task "<task>"|--domain <domain>` surfaces which axes (knowledge / rules / paths / templates / scaffold patterns / playbooks / helpers / validation commands / contract templates) are missing for a task or domain.',
    content: [
      'Integrates into `shrk task --show-coverage-gaps`. MCP tool: `get_scaffold_coverage_report`.',
    ].join('\n\n'),
    references: [
      { kind: 'file', path: 'packages/inspector/src/scaffold-coverage.ts', required: true },
      { kind: 'symbol', symbol: 'buildScaffoldCoverageReport', path: 'packages/inspector/src/scaffold-coverage.ts', required: true },
      { kind: 'command', command: 'shrk coverage scaffolds --task "add primitive adapter"' },
    ],
  }),
  defineKnowledgeEntry({
    id: 'engine.search-tuning-explain-cli',
    title: 'Search-tuning explain — first-class CLI (R31)',
    type: 'technical',
    priority: 'medium',
    scope: ['search-tuning', 'r31'],
    tags: ['search-tuning', 'explain', 'r31'],
    appliesWhen: ['debug-tuning'],
    summary:
      '`shrk search-tuning explain "<query>"` top-level alias; `--kind` / `--source` / `--limit` / `--format` flags on the subcommand form.',
    content: [
      'Top-level alias keeps the surface short. Underlying `explainSearchTuning` unchanged.',
    ].join('\n\n'),
    references: [
      { kind: 'file', path: 'packages/cli/src/commands/search.command.ts', required: true },
      { kind: 'command', command: 'shrk search-tuning explain "rename plugin"' },
    ],
  }),
  defineKnowledgeEntry({
    id: 'engine.symbol-impact',
    title: 'Direct symbol impact / trace (R31)',
    type: 'technical',
    priority: 'medium',
    scope: ['impact', 'trace', 'symbol', 'r31'],
    tags: ['impact', 'trace', 'symbol', 'r31'],
    appliesWhen: ['impact-symbol', 'trace-symbol'],
    summary:
      '`shrk impact --symbol <Name>` and `shrk trace --symbol <Name>` walk the AST-backed symbol index and run the file-impact engine when exactly one exact-export match exists.',
    content: [
      'Multiple matches surface as alternatives. Missing symbols return next-command hints. `--language` filters which file types are scanned.',
    ].join('\n\n'),
    references: [
      { kind: 'file', path: 'packages/inspector/src/symbol-index.ts', required: true },
      { kind: 'symbol', symbol: 'findSymbolInProject', path: 'packages/inspector/src/symbol-index.ts', required: true },
      { kind: 'command', command: 'shrk impact --symbol buildTaskRiskReport' },
    ],
  }),
  defineKnowledgeEntry({
    id: 'engine.changes-summary',
    title: 'Changes summary (R31)',
    type: 'technical',
    priority: 'medium',
    scope: ['changes', 'r31'],
    tags: ['changes', 'diff', 'r31'],
    appliesWhen: ['summarise-changes'],
    summary:
      '`shrk changes summary --since <ref>|--staged|--files a,b` groups the diff by area, flags safety-relevant + MCP files, and suggests validation commands. Schema: `sharkcraft.changes-summary/v1`.',
    content: [
      'Risk verdict is low/medium/high based on MCP/safety/write-path counts.',
    ].join('\n\n'),
    references: [
      { kind: 'file', path: 'packages/inspector/src/changes-summary.ts', required: true },
      { kind: 'symbol', symbol: 'buildChangesSummary', path: 'packages/inspector/src/changes-summary.ts', required: true },
      { kind: 'command', command: 'shrk changes summary --since main' },
    ],
  }),
  defineKnowledgeEntry({
    id: 'engine.pr-summary',
    title: 'PR summary generator (R31)',
    type: 'technical',
    priority: 'medium',
    scope: ['pr', 'r31'],
    tags: ['pr', 'review', 'r31'],
    appliesWhen: ['generate-pr-description'],
    summary:
      '`shrk pr summary --since <ref>` builds a deterministic PR description from the changes summary + .sharkcraft/reports. Defaults to markdown stdout; `--output <file>` writes to disk.',
    content: [
      'MCP tool: `get_pr_summary_preview` is read-only.',
    ].join('\n\n'),
    references: [
      { kind: 'file', path: 'packages/inspector/src/pr-summary.ts', required: true },
      { kind: 'symbol', symbol: 'buildPrSummary', path: 'packages/inspector/src/pr-summary.ts', required: true },
      { kind: 'command', command: 'shrk pr summary --staged' },
    ],
  }),
  defineKnowledgeEntry({
    id: 'engine.ci-integrity-report',
    title: 'CI integrity report aggregator (R31)',
    type: 'technical',
    priority: 'medium',
    scope: ['ci', 'r31'],
    tags: ['ci', 'integrity', 'r31'],
    appliesWhen: ['aggregate-ci-reports'],
    summary:
      '`shrk ci report --reports-dir <dir> --format markdown|html|json --fail-on error|warning|none` reads .sharkcraft/reports/*.json and renders a single CI integrity verdict.',
    content: [
      'MCP tool: `get_ci_integrity_report` (read-only).',
    ].join('\n\n'),
    references: [
      { kind: 'file', path: 'packages/inspector/src/ci-integrity-report.ts', required: true },
      { kind: 'symbol', symbol: 'buildCiIntegrityReport', path: 'packages/inspector/src/ci-integrity-report.ts', required: true },
      { kind: 'command', command: 'shrk ci report' },
    ],
  }),
  defineKnowledgeEntry({
    id: 'engine.uncertainty-reporting',
    title: 'Uncertainty reporting (R31)',
    type: 'technical',
    priority: 'medium',
    scope: ['uncertainty', 'r31'],
    tags: ['uncertainty', 'task-packet', 'r31'],
    appliesWhen: ['build-task-packet'],
    summary:
      '`shrk task "<task>"` always renders a confidence + uncertainty[] footer. Signals: no template / no path convention / weak knowledge / no validation. `--show-coverage-gaps` includes the coverage report inline.',
    content: [
      'Pure: derived from the task packet — no I/O.',
    ].join('\n\n'),
    references: [
      { kind: 'file', path: 'packages/inspector/src/uncertainty.ts', required: true },
      { kind: 'symbol', symbol: 'buildUncertaintySummary', path: 'packages/inspector/src/uncertainty.ts', required: true },
      { kind: 'command', command: 'shrk task "add primitive adapter" --show-coverage-gaps' },
    ],
  }),
];
