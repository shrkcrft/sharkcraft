export * from './doctor-result.ts';
export * from './doctor-verdict-kind.ts';
export * from './i-doctor-verdict.ts';
export * from './doctor-verdict.ts';
export * from './quality-gate-status.ts';
export * from './quality-gate-row-status.ts';
export * from './code-intelligence-doctor.ts';
export * from './project-overview.ts';
export * from './sharkcraft-inspector.ts';
export * from './inspector-cache.ts';
export * from './loader-diagnostics.ts';
export * from './agent-instructions.ts';
export * from './action-hint-diagnostics.ts';
export * from './ai-readiness.ts';
export * from './pack-doctor.ts';
export * from './pack-doctor-verdict.ts';
export * from './i-pack-doctor-verdict.ts';
export * from './task-packet.ts';
export * from './context-tuning.ts';
export * from './resolve-verification-commands.ts';
export * from './resolve-project-config.ts';
export * from './reference-lookup.ts';
export * from './task-ranker.ts';
export * from './drift.ts';
export * from './knowledge-graph.ts';
export * from './propose-knowledge.ts';
export * from './rounds.ts';
export * from './surface-profile-detect.ts';
export * from './coverage-report.ts';
export * from './review-packet.ts';
export * from './test-definitions.ts';
export * from './test-runner.ts';
export * from './plan-review.ts';
export * from './onboarding.ts';
export * from './onboarding-report.ts';
export * from './synthesize-from-onboarding.ts';
export * from './onboarding-drafts.ts';
export * from './onboarding-diff.ts';
export * from './onboarding-adoption.ts';
export * from './adoption-state.ts';
export * from './adoption-three-way.ts';
export * from './adoption-merge-preview.ts';
export * from './adoption-report-renderer.ts';
export * from './adoption-check.ts';
export * from './quality-report.ts';
export * from './quality-gate-examination.ts';
export * from './quality-report-coverage.ts';
export * from './safety-audit.ts';
export * from './onboarding-agent-import.ts';
export * from './monorepo-onboarding.ts';
export * from './template-body-inference.ts';
export * from './template-body-inference-v2.ts';
export * from './scaffold-patterns.ts';
export * from './quality-html.ts';
export * from './safety-html.ts';
export * from './review-html.ts';
export * from './review-comment-renderer.ts';
export * from './dev-session.ts';
export * from './dev-session-report.ts';
export * from './dev-session-html.ts';
export * from './dashboard/dashboard-data.ts';
export * from './dashboard/dashboard-knowledge.ts';
export * from './git-helpers.ts';
export * from './boundaries-changed-only.ts';
// The ONE boundary orchestrator (round 11) + its authorities: configuration
// status, rule sources / changeset escalation, load issues.
export * from './run-boundary-check.ts';
export * from './boundary-check-options.model.ts';
export * from './boundary-check-result.model.ts';
export * from './boundary-rule-check.model.ts';
export * from './boundary-rule-set-diff.model.ts';
export * from './boundary-stale-exception-finding.model.ts';
export * from './boundary-configuration-status.ts';
export * from './boundary-configuration-status.model.ts';
export * from './boundary-load-issue.model.ts';
export * from './boundary-rule-sources.ts';
export * from './boundary-rule-invalidation.model.ts';
export * from './helper-registry.ts';
export * from './pack-author-ux.ts';
export * from './pack-test-runner.ts';
export * from './registry-lifecycle.ts';
export * from './ingest-body-extractor.ts';
export * from './area-map.ts';
export * from './task-decompose.ts';
export * from './feature-bundle.ts';
export * from './plan-dependency-graph.ts';
export * from './impact-analysis.ts';
export * from './test-impact.ts';
export * from './ownership.ts';
export * from './policy-engine.ts';
export * from './quality-baseline.ts';
export * from './drift-baseline.ts';
export * from './import-graph-analysis.ts';
export * from './boundary-suggestions.ts';
export * from './template-lint.ts';
export * from './pipeline-lint.ts';
export * from './pack-quality-score.ts';
export * from './pack-compatibility.ts';
export * from './pack-symbol-compat.ts';
export * from './export-bundle.ts';
export * from './review-packet-v2.ts';
export * from './review-comment-v2.ts';
export * from './review-packet-v3.ts';
export * from './bundle-validate-html.ts';
export * from './report-site.ts';
export * from './construct-registry.ts';
export * from './construct-inference.ts';
export * from './construct-adoption.ts';
export * from './construct-adoption-diff.ts';
export * from './onboarding-adoption-diff.ts';
export * from './adoption-checkpoint.ts';
export * from './ci-scaffold.ts';
export * from './ci-permissions.ts';
export * from './demo-script.ts';
export * from './demo-workflow.ts';
export * from './demo-package.ts';
export * from './release-readiness.ts';
export * from './pack-release-check.ts';
export * from './playbook-registry.ts';
export * from './policy-registry.ts';
export * from './playbook-script.ts';
export * from './search-index.ts';
export * from './search-tuning-registry.ts';
export * from './search-tuning-explain.ts';
// Round 11 (doctor lane): THE search-document id codec, THE tuning trigger
// tokenizer, THE boost-key resolver and THE search-tuning lint.
export * from './search-document-prefix.ts';
export * from './search-document-id.ts';
export * from './tuning-query-tokens.ts';
export * from './search-tuning-key-status.ts';
export * from './search-tuning-key-resolution.ts';
export * from './search-tuning-key-resolver.ts';
export * from './i-search-tuning-lint-issue.ts';
export * from './i-search-tuning-lint-report.ts';
export * from './search-tuning-lint.ts';
// Round 13 (lane A — intended-empty asset units): THE boost-key probes, THE
// asset-doctor proposal, THE scaffold-pattern doctor report, and the unit
// lines of several settles.
export * from './i-search-tuning-key-probe.ts';
export * from './search-tuning-key-probes.ts';
export * from './i-asset-doctor-flags.ts';
export * from './asset-doctor-proposed-exit.ts';
export * from './i-scaffold-pattern-doctor-report.ts';
export * from './scaffold-pattern-doctor-report.ts';
export * from './settled-unit-states.ts';
export * from './agent-brief.ts';
export * from './bundle-replay.ts';
export * from './bundle-diff.ts';
export * from './impact-render.ts';
export * from './impact-graph.ts';
export * from './impact-graph-render.ts';
export * from './policy-test.ts';
export * from './ci-permissions-fix.ts';
export * from './start-here.ts';
export * from './agent-handoff.ts';
export * from './repository-map.ts';
export * from './repository-stats.ts';
export * from './docs-check.ts';
export * from './examples-check.ts';
export * from './failure-diagnostics.ts';
export * from './release-smoke.ts';
export * from './install-smoke.ts';
export * from './self-audit.ts';
export * from './change-intent.ts';
export * from './repository-intelligence.ts';
export * from './architecture-map.ts';
export * from './agent-orchestration.ts';
export * from './workflow-simulation.ts';
export * from './decision-records.ts';
export * from './compliance-profiles.ts';
export * from './policy-overrides.ts';
export * from './pack-docs.ts';
export * from './reposet.ts';
export * from './role-views.ts';
export * from './command-recommender.ts';
export * from './diagnostics-suggest.ts';
export * from './dashboard-export.ts';
export * from './golden-output.ts';
export * from './release-train.ts';
export * from './upgrade-advisor.ts';
export * from './safety-audit-deep.ts';
export * from './api-report.ts';
export * from './risk-signals.ts';
export * from './compliance-evidence.ts';
export * from './policy-override-audit.ts';
export * from './command-taxonomy.ts';
export * from './product-coherence.ts';
export * from './task-risk.ts';
export * from './migration-readiness.ts';
export * from './contract-file-rule.ts';
export * from './check-guardrail-globs.ts';
export * from './delegate-catalog.ts';
export * from './delegate-grounding.ts';
export * from './delegate-pack-recipes.ts';
export * from './delegate-doctor.ts';
export * from './agent-contract.ts';
export * from './plan-simulation.ts';
export * from './repo-memory.ts';
export * from './healing-plan.ts';
export * from './execution-graph.ts';
export * from './agent-contract-gate.ts';
export * from './apply-gate-result.ts';
export * from './memory-diff.ts';
export * from './agent-contract-templates.ts';
export * from './languages/index.ts';
export * from './generated-code.ts';
export * from './contradictions.ts';
export * from './stability-map.ts';
export * from './repository-knowledge-model.ts';
export * from './ingest-drafts.ts';
export * from './ingest-adoption.ts';
export * from './ingest-apply.ts';
export * from './changed-scope.ts';
export * from './doctor-suppressions.ts';
export * from './knowledge-stale.ts';
// Round 11: the stale-check's three entry buckets, failure modes, per-kind
// counts, content/count assertions and discovery — one construct per file.
export * from './knowledge-entry-verdict.ts';
export * from './knowledge-unverifiable-reason.ts';
export * from './knowledge-entry-verdict-record.ts';
export * from './knowledge-stale-coverage.ts';
export * from './knowledge-kind-bucket.ts';
export * from './knowledge-reference-kind-bucket.ts';
export * from './knowledge-stale-advisory.ts';
export * from './declared-reference-coverage.ts';
export * from './knowledge-stale-gate.ts';
export * from './knowledge-stale-gate-flags.ts';
export * from './knowledge-stale-gate-input.ts';
export * from './knowledge-stale-gate-result.ts';
export * from './knowledge-stale-gate-rule.ts';
export * from './knowledge-stale-gate-violation.ts';
export * from './knowledge-stale-quality-gate.ts';
// Round 15 (15.2): THE remedy wording for an unverifiable entry (TS / Markdown / pack).
export * from './knowledge-min-referenced-valve.ts';
export * from './knowledge-unverifiable-remedy.ts';
// Round 15 closing (A4): an unverifiable file line is one declaring file AND one remedy.
export * from './i-unverifiable-remedy-group.ts';
// Round 15 follow-up (F3): knowledge entries the loader REJECTED — one reading
// of the rejection channel for the stale-check, quality and doctor.
export * from './knowledge-rejected-entry.ts';
export * from './knowledge-entry-rejections.ts';
// Round 15 follow-up (F11): the knowledge slots `packs test --load` and the
// build-time validator pick the knowledge loader by.
export * from './knowledge-contribution-slots.ts';
export * from './declared-gate-plane-rules.ts';
export * from './i-command-safety.ts';
export * from './knowledge-advisory-code.ts';
export * from './knowledge-aged-entry.ts';
export * from './reference-failure.ts';
export * from './reference-asset-kind.ts';
export * from './reference-subject.ts';
export * from './reference-content-check.ts';
export * from './policy-declaration.ts';
export * from './inspection-discovery.ts';
export * from './knowledge-load-failure.ts';
export * from './symbol-member-kind.ts';
export * from './symbol-member-entry.ts';
export * from './knowledge-rename.ts';
// Round 15 lane B (B1): THE `knowledge rename-*` command a hint suggests.
export * from './knowledge-rename-verb.ts';
export * from './knowledge-rename-command.ts';
export * from './template-drift.ts';
export * from './barrel-operations.ts';
export * from './query-resolver.ts';
export * from './feedback-ingestion.ts';
export * from './fuzzy-impact.ts';
export * from './symbol-index.ts';
export * from './ranker-explainability.ts';
export * from './command-suggester.ts';
export * from './fix-preview.ts';
export * from './scaffold-coverage.ts';
export * from './changes-summary.ts';
export * from './pr-summary.ts';
export * from './ci-integrity-report.ts';
export * from './uncertainty.ts';
export * from './contract-template-registry.ts';
export * from './migration-profile-registry.ts';
export * from './profile-registry.ts';
export * from './project-coupling-audit.ts';
export * from './pack-contributions-inventory.ts';
export * from './convention-registry.ts';
// round 15 (15.1): THE convention applicability authority + the per-file language table
export * from './convention-applicability.ts';
export * from './convention-filter-level.ts';
export * from './i-convention-applicability.ts';
export * from './i-convention-applicability-reason.ts';
export * from './i-convention-scope.ts';
export * from './i-not-applicable-convention.ts';
export * from './file-languages.ts';
export * from './i-file-language.ts';
export * from './comment-syntax.ts';
export * from './self-config-doctor.ts';
// v2 graph validation
export * from './self-config-doctor-v2.ts';
// doctor acknowledgements (typed wrapper around suppressions)
export * from './doctor-acknowledgements.ts';
// apply dispatch trace
export * from './apply-dispatch-trace.ts';
// changed-only preflight planner
export * from './changed-preflight.ts';
// entrypoint matrix
export * from './entrypoint-matrix.ts';
export * from './schema-inventory.ts';
export * from './area-explore.ts';
export * from './acceptance-replay.ts';
export * from './pack-helper-registry.ts';
export * from './task-routing-hint-registry.ts';
export * from './registration-hint-registry.ts';
// Round 11 (doctor lane): the routing `recommends` channel table and the
// registration-hint discovery status.
export * from './routing-recommends-channels.ts';
export * from './registration-hint-discovery-status.ts';
export * from './import-hygiene.ts';
export * from './dev-cycle.ts';
export * from './ci-predict.ts';
export * from './pack-signature-status.ts';
// Round 11 (packs lane): one freshness authority, one load-failure authority,
// one in-process typecheck, one helper catalog.
export * from './pack-asset-freshness.ts';
export * from './contribution-load-failures.ts';
// Round 12 (12.1 + ONE-CHANGE): THE per-entry rejection channel, every
// registry loader's outcome, and the per-file contributions report.
export * from './i-contribution-entry-rejection.ts';
export * from './i-contribution-accepted-entry.ts';
export * from './i-contribution-file-issue.ts';
export * from './i-registry-outcomes.ts';
// Round 12 review (A-4): a list verb's note carries load failures too.
export * from './i-kind-outcomes.ts';
export * from './framework-extractor-outcomes.ts';
export * from './unresolvable-reason.ts';
export * from './i-unresolvable-reference.ts';
export * from './i-unresolvable-reference-scan.ts';
export * from './i-contribution-file-report.ts';
export * from './i-contributions-report.ts';
export * from './contributions-report.ts';
export * from './i-contribution-file-validation.ts';
export * from './validate-contribution-file.ts';
export * from './typecheck-files.ts';
export * from './helper-view.ts';
export * from './helper-catalog.ts';
export * from './pack-helper-plan.ts';
export * from './substitute-placeholders.ts';
export * from './unregistered-exports.ts';
export * from './pack-manifest-reader.ts';
export * from './pack-typecheck.ts';
// rule enforcement classification (drift rules).
export * from './rule-drift.ts';
export * from './agent-task-prep.ts';
export * from './uncertainty-report.ts';
export * from './universal-search.ts';
export * from './feedback-actions-v2.ts';
export * from './rule-scaffold.ts';
export * from './rule-quality.ts';
export * from './custom-checks.ts';
export * from './codemod-assist.ts';
export * from './knowledge-authoring.ts';
export * from './knowledge-lint.ts';
export * from './pack-author.ts';
export * from './asset-provenance.ts';
export * from './pack-pending.ts';
export * from './template-authoring.ts';
export * from './check-result-v1.ts';
// spec cross-validation
export * from './spec/spec-cross-validate.ts';
export * from './spec/spec-review.ts';
export * from './spec/spec-discovery.ts';
// shared validation pipeline (`validateExtractedPlan`)
export * from './grounding/validate-extracted-plan.ts';
// `shrk grounding` builder
export * from './grounding/build-grounding.ts';
// Nx project graph reader (pure fs)
export * from './grounding/nx-projects.ts';
// DX/feedback3 — `shrk why <file>` report builder.
export * from './why-file.ts';
export * from './nearest-id.ts';
export * from './reference-registry.ts';
// Round 12 (12.3): how every resolvable kind is DECLARED, and the builtin
// workspace-profile payload.
export * from './i-reference-kind-declaration.ts';
export * from './reference-kind-declarations.ts';
export * from './i-workspace-profile-payload.ts';
// Round 12 (12.3): THE field → kind binding the doctor probes.
export * from './probed-id-source.ts';
export * from './i-probed-id-field.ts';
export * from './probed-id-fields.ts';
// The injected command-resolution contract (the CLI builds the resolver).
export * from './command-resolution-status.ts';
export * from './i-command-resolution.ts';
export * from './i-reference-warm-options.ts';
export * from './i-command-resolve-options.ts';
export * from './reference-id-status.ts';
export * from './doc-references.ts';
// Declared cross-references (round 11, 4.2): THE table of asset fields that
// carry ids, resolved through the reference registry — the structured twin of
// doc-references.
export * from './declared-cross-references.ts';
export * from './declared-xref-status.ts';
export * from './i-declared-xref-field.ts';
export * from './i-declared-xref-issue.ts';
export * from './i-declared-xref-report.ts';
export * from './i-declared-xref-row.ts';
// THE identifier tokenizer (round 11) — reuse, spec evidence and the
// recommender split identifiers with this one function.
export * from './split-identifier.ts';
// THE term matcher and THE query-intent classifier (round 11, 2.3 / 2.5) —
// routing hints, playbooks, recipes, change-intent and the recommender read them.
export * from './term-query.ts';
export * from './match-terms.ts';
export * from './query-intent-kind.ts';
export * from './query-intent-result.ts';
export * from './query-intent.ts';
// THE recommendation ranking (round 11, 2.1 / 2.2): one ranked list behind
// `recommend`, MCP `recommend_commands` and `shrk context`.
export * from './command-safety-level.ts';
export * from './recommendation-source.ts';
export * from './recommendation-suppression.ts';
export * from './recommendation-candidate.ts';
export * from './recommendation-confidence.ts';
export * from './recommendation-ranking-options.ts';
export * from './ranked-recommendations.ts';
export * from './recommend-recipe.ts';
export * from './recommend-recipes.ts';
export * from './recommendation-ranking.ts';
export * from './playbook-load-issue.ts';
// Reuse engine (round 11): pure; the public export surface and the graph
// lookups are INJECTED by the caller — the inspector never imports the graph.
export * from './reuse/reuse-tokenize.ts';
export * from './reuse/score-reuse-name.ts';
export * from './reuse/reuse-match-detail.ts';
export * from './reuse/score-reuse-primitive.ts';
export * from './reuse/reuse-suggestion.ts';
export * from './reuse/rank-reuse-suggestions.ts';
export * from './reuse/reuse-candidate.ts';
export * from './reuse/reuse-ranking.ts';
export * from './reuse/rank-reuse-options.ts';
export * from './reuse/rank-reuse-candidates.ts';
export * from './reuse/reuse-curated-status.ts';
export * from './reuse/reuse-curated-coverage.ts';
export * from './reuse/reuse-symbol-lookup.ts';
export * from './reuse/reuse-curated-resolution.ts';
export * from './reuse/resolve-curated-reuse.ts';
export * from './reuse/reuse-coverage-report.ts';
export * from './reuse/compute-reuse-coverage.ts';
