/**
 * R30 PART 8 — SharkCraft TypeScript decision records.
 *
 * Mirror of the markdown ADRs under `sharkcraft/decisions/`. The TS form
 * lets packs ship typed decision records, and integrates with
 * `shrk decisions list` + the new `shrk decisions doctor`.
 */

interface ILocalDecision {
  id: string;
  title: string;
  status?: 'proposed' | 'accepted' | 'rejected' | 'superseded';
  date?: string;
  context: string;
  decision: string;
  consequences: string;
  relatedRules?: readonly string[];
  relatedPolicies?: readonly string[];
  relatedConstructs?: readonly string[];
  relatedFiles?: readonly string[];
  relatedKnowledge?: readonly string[];
  relatedTemplates?: readonly string[];
  relatedPlaybooks?: readonly string[];
  relatedCommands?: readonly string[];
}

function defineDecision(d: ILocalDecision): ILocalDecision {
  return d;
}

export default [
  defineDecision({
    id: 'fuzzy-impact-uses-shared-resolver',
    title: 'Fuzzy impact reuses the trace query resolver',
    status: 'accepted',
    date: '2026-05-15',
    context:
      'R29 shipped a fuzzy resolver for `shrk trace`. R30 PART 1 extends `shrk impact` to accept the same kind of free-form input, but impact needs to map matches to files instead of just rendering them.',
    decision:
      'Build `resolveFuzzyImpact` as a thin wrapper over `resolveQuery` that maps each match kind (construct / symbol / plugin-key / etc.) back to a file list using the same registries the rest of the engine reads from. Auto-run impact only on `exact` / `high` confidence; surface alternatives otherwise.',
    consequences:
      'The resolver path becomes the single source of truth for fuzzy lookups. Impact can never silently run on a low-confidence match — the user always sees the alternatives.',
    relatedKnowledge: ['engine.fuzzy-impact'],
    relatedCommands: ['shrk impact <query>', 'shrk impact <query> --resolve-only', 'shrk impact <query> --explain-resolution'],
  }),
  defineDecision({
    id: 'agent-tests-strict-expectations',
    title: 'Agent tests gain strict expectation fields',
    status: 'accepted',
    date: '2026-05-15',
    context:
      'R29 agent tests pass with weak expectations (`expectedRules` only). The ranker can drift without test failures.',
    decision:
      'Extend `IAgentContractTest` with expectedHelpers, expectedPlaybooks, expectedPolicies, expectedConstructs, expectedCommands, expectedKnowledge, mustNotInclude. Pre-load registries asynchronously so the sync runner can evaluate policy/playbook/construct membership reliably.',
    consequences:
      'Tests fail fast when an expected asset disappears. mustNotInclude catches the "ranker started surfacing the wrong thing" class of drift.',
    relatedRules: ['repo.architecture.respect-layer-order'],
    relatedKnowledge: ['engine.agent-test-strict-expectations'],
  }),
  defineDecision({
    id: 'knowledge-stale-check-ci-default-non-blocking',
    title: 'Knowledge stale-check is non-blocking by default',
    status: 'accepted',
    date: '2026-05-15',
    context:
      'R29 stale-check exits non-zero on any stale or missing reference, which is too aggressive for local use.',
    decision:
      'Local mode is non-blocking unless --fail-on is specified. `--ci` blocks on `required: true` failures. `--strict` treats any required failure as blocking. `--baseline` enables diff-vs-previous-run comparisons.',
    consequences:
      'Teams can opt into the CI gate when they are ready, without breaking existing local usage.',
    relatedKnowledge: ['engine.knowledge-stale-ci-gate'],
    relatedCommands: ['shrk knowledge stale-check --ci'],
  }),
  defineDecision({
    id: 'ast-backed-symbol-verification',
    title: 'AST-backed symbol verification with text fallback',
    status: 'accepted',
    date: '2026-05-15',
    context:
      'R29 used a deterministic text scan. False positives/negatives occur for re-exports and unusual declaration shapes.',
    decision:
      'Add `packages/inspector/src/symbol-index.ts` using TypeScript single-file parsing (no whole-program type-checking). Knowledge stale-check, query resolver, and fuzzy impact all use it. On parse failure or absent file, fall back to the R29 text scan.',
    consequences:
      'Confidence levels become richer: exact-export / exact-local / exact-reexport / probable-text. No new runtime dependencies (typescript is already present).',
    relatedKnowledge: ['engine.ast-backed-symbol-verification'],
    relatedFiles: ['packages/inspector/src/symbol-index.ts'],
  }),
  defineDecision({
    id: 'template-drift-severity-controls',
    title: 'Template drift gets severity + filter + strict + CI controls',
    status: 'accepted',
    date: '2026-05-15',
    context:
      'R29 template drift fired `path-no-convention` for any template without a covering path convention. This was noise in packs without complete path coverage.',
    decision:
      'Add --min-severity, --hide <code>, --strict, --ci, --format text|markdown|html|json. Strict mode promotes warnings to errors at exit time; CI mode reports the structured payload but only fails on errors.',
    consequences:
      'Default behaviour unchanged. CI integrations get a structured contract; local users get noise reduction without losing signal.',
    relatedKnowledge: ['engine.template-drift-noise-control'],
    relatedCommands: ['shrk templates drift --min-severity warning', 'shrk templates drift --ci'],
  }),
  defineDecision({
    id: 'feedback-rules-pack-extensible',
    title: 'Feedback ingestion rules become pack-extensible',
    status: 'accepted',
    date: '2026-05-15',
    context:
      'R29 KEYWORD_RULES was a fixed inline array. Project-specific feedback rules had no extension point.',
    decision:
      'Expose `IFeedbackRule` (schema sharkcraft.feedback-rule/v1). Local file: sharkcraft/feedback-rules.ts. Pack contribution: feedbackRuleFiles[]. Built-in rules apply first so the existing classifications are preserved.',
    consequences:
      'Packs can ship their own categorisation rules without forking the inspector. `shrk feedback rules list|doctor` surface what is loaded.',
    relatedKnowledge: ['engine.feedback-rules-pack-extensible'],
    relatedCommands: ['shrk feedback rules list', 'shrk feedback rules doctor', 'shrk feedback ingest <file> --with-pack-rules'],
  }),
  defineDecision({
    id: 'ts-decisions-loader-supplements-markdown',
    title: 'TS decisions loader supplements markdown ADRs',
    status: 'accepted',
    date: '2026-05-15',
    context:
      'R29 ADRs live as markdown under `sharkcraft/decisions/`. Packs cannot easily ship typed decisions, and decisions cannot reference IDs the type system can check.',
    decision:
      'Add async `loadTsDecisions` reading `sharkcraft/decisions.ts` + pack `decisionFiles[]`. Markdown loader remains the primary surface; TS records are folded in via cache. Duplicate ids are skipped with markdown winning.',
    consequences:
      'Existing markdown ADRs are unchanged. Packs ship typed decisions for cross-tool reference. `shrk decisions doctor` validates both sources.',
    relatedKnowledge: ['engine.ts-decisions-loader'],
    relatedCommands: ['shrk decisions list', 'shrk decisions doctor'],
  }),
  defineDecision({
    id: 'project-path-conventions-are-a-pack-contribution',
    title: 'Project-specific path conventions live in packs',
    status: 'accepted',
    date: '2026-05-15',
    context:
      'Each adopter project has its own folder layout. SharkCraft itself does not know which folders any specific project uses.',
    decision:
      'Document recommended additions in adopter-side reports and leave pack maintainers to paste the conventions into `<pack>/src/assets/paths.ts`. SharkCraft engine code never duplicates project-specific knowledge.',
    consequences:
      'Engine stays free of project-specific data. Pack maintainers decide when to publish additions and re-sign the manifest.',
  }),
  defineDecision({
    id: 'ci-scaffolds-include-integrity-gates',
    title: 'CI scaffolds can include knowledge stale-check and template drift',
    status: 'accepted',
    date: '2026-05-15',
    context:
      'R29 integrity checks are useful but not surfaced in generated CI workflows. Teams forget to wire them up.',
    decision:
      'Add --with-knowledge-check, --with-template-drift, --with-integrity to `shrk ci scaffold github-actions` and equivalent flags on other providers. Output is dry-run by default per safety policy.',
    consequences:
      'Teams that adopt the scaffold get the integrity gates by default when they opt in. No silent surprise — flags are explicit.',
    relatedKnowledge: ['engine.ci-integrity-gates'],
    relatedCommands: ['shrk ci scaffold github-actions --with-integrity'],
  }),
];
