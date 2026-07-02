#!/usr/bin/env node
import { loadDotenv } from './env/load-dotenv.ts';
import {
  CommandRegistry,
  extractGlobalCompress,
  extractGlobalCwd,
  parseArgs,
  type ICommandHandler,
} from './command-registry.ts';
import { runCommandWithCompression } from './output/output-compression.ts';
import { initCommand } from './commands/init.command.ts';
import { inspectCommand } from './commands/inspect.command.ts';
import {
  doctorAcknowledgeCommand,
  doctorAcknowledgementsCommand,
  doctorCommand,
  doctorSuppressCommand,
  doctorSuppressionsCommand,
} from './commands/doctor.command.ts';
import {
  knowledgeAnchorsCommand,
  knowledgeGetCommand,
  knowledgeListCommand,
  knowledgeReferencesCommand,
  knowledgeRenameFileCommand,
  knowledgeRenameSymbolCommand,
  knowledgeSearchCommand,
  knowledgeStaleCheckCommand,
  knowledgeUpdateAnchorCommand,
  knowledgeVerifyCommand,
} from './commands/knowledge.command.ts';
import {
  knowledgeAddCommand,
  knowledgeLintCommand,
  knowledgeRemoveCommand,
  knowledgeUpdateCommand,
} from './commands/knowledge-author.command.ts';
import { knowledgeProposeCommand } from './commands/knowledge-propose.command.ts';
import {
  provenanceDoctorCommand,
  provenanceListCommand,
  provenanceMissingCommand,
  provenanceReportCommand,
  provenanceShowCommand,
} from './commands/provenance.command.ts';
import {
  packAuthorPendingCommand,
  packAuthorPreviewCommand,
  packAuthorStatusCommand,
  packAuthorValidateCommand,
} from './commands/pack-author.command.ts';
import {
  rulesAddCommand,
  rulesDoctorCommand,
  rulesGetCommand,
  rulesLintCommand,
  rulesListCommand,
  rulesRelevantCommand,
  rulesRemoveCommand,
  rulesScaffoldCommand,
  rulesUpdateCommand,
} from './commands/rules.command.ts';
import {
  checksListCommand,
  checksDoctorCommand,
  checksRunCommand,
  checksParseReportCommand,
  checksImportCommand,
  checksAggregateCommand,
  checksReportCommand,
  checksConvertCommand,
} from './commands/checks.command.ts';
import { codemodCommand } from './commands/codemod.command.ts';
import {
  pathsListCommand,
  pathsGetCommand,
  pathsSearchCommand,
  pathsBestCommand,
} from './commands/paths.command.ts';
import {
  templatesAddCommand,
  templatesDoctorCommand,
  templatesDriftCommand,
  templatesGetCommand,
  templatesListCommand,
  templatesPreviewCommand,
  templatesRemoveCommand,
  templatesScaffoldCommand,
  templatesSearchCommand,
  templatesSmokeCommand,
  templatesUpdateCommand,
  templatesVarsCommand,
  templatesVerifyPathsCommand,
} from './commands/templates.command.ts';
import {
  pipelinesListCommand,
  pipelinesGetCommand,
  pipelinesContextCommand,
  pipelinesPlanCommand,
  pipelinesScriptCommand,
  pipelinesNextCommand,
  pipelinesVarsCommand,
} from './commands/pipelines.command.ts';
import {
  packsListCommand,
  packsContributionsCommand,
  packsConflictsCommand,
  packsSignatureStatusCommand,
  packsGetCommand,
  packsInspectCommand,
  packsDoctorCommand,
  packsReleaseCheckCommand,
  packsCompatCommand,
  packsSignCommand,
  packsVerifyCommand,
  packsDevStatusCommand,
  packsWatchCommand,
} from './commands/packs.command.ts';
import { packsNewCommand, packsTestCommand } from './commands/packs-new.ts';
import {
  presetsListCommand,
  presetsGetCommand,
  presetsExplainCommand,
  presetsRecommendCommand,
  presetsPreviewCommand,
  presetsApplyCommand,
  presetsDoctorCommand,
  presetsDiffCommand,
  presetsPatchCommand,
} from './commands/presets.command.ts';
import { taskCommand } from './commands/task.command.ts';
import { preflightCommand } from './commands/preflight.command.ts';
import { checkCommand } from './commands/check.command.ts';
import { finishCommand } from './commands/finish.command.ts';
import { diffCheckCommand } from './commands/diff-check.command.ts';
import { driftCommand } from './commands/drift.command.ts';
import { graphCommand } from './commands/graph.command.ts';
import { ruleGraphCommand } from './commands/rule-graph-subverbs.ts';
import { searchStructuralCommand } from './commands/search-structural.command.ts';
import { planContextCommand } from './commands/plan-context.command.ts';
import { archCommand } from './commands/arch.command.ts';
import { frameworkCommand } from './commands/framework.command.ts';
import { apiDiffCommand } from './commands/api-diff.command.ts';
import { gateCommand } from './commands/gate.command.ts';
import { policyLintCommand } from './commands/policy-lint.command.ts';
import { wiringCommand } from './commands/wiring.command.ts';
import { reuseCommand } from './commands/reuse.command.ts';
import { migrateCommand } from './commands/migrate.command.ts';
import { coverageCommand } from './commands/coverage.command.ts';
import { statsCommand } from './commands/stats.command.ts';
import { compressCommand, expandCommand } from './commands/compress.command.ts';
import { alignCommand, unalignCommand } from './commands/cache-align.command.ts';
import { reviewCommand } from './commands/review.command.ts';
import { onboardCommand } from './commands/onboard.command.ts';
import {
  contradictionsCommand,
  generatedCommand,
  ingestCommand,
} from './commands/ingest.command.ts';
import {
  contextBuildCommand,
  contextRefreshCommand,
  contextStatusCommand,
  understandTaskCommand,
  validateChangeCommand,
} from './commands/task-context.command.ts';
import { testCommand } from './commands/test.command.ts';
import { planParentCommand, planReviewCommand } from './commands/plan.command.ts';
import { devCommand } from './commands/dev.command.ts';
import {
  explainCommand,
} from './commands/daily.commands.ts';
import {
  schemasListCommand,
  schemasGetCommand,
  schemasInventoryCommand,
  schemasWriteCommand,
  schemasEmitCommand,
} from './commands/schemas.command.ts';
import { contextCommand } from './commands/context.command.ts';
import {
  diffParentCommand,
  diffRoundsCommand,
  roundsCaptureCommand,
  roundsListCommand,
  roundsParentCommand,
  roundsShowCommand,
} from './commands/rounds.command.ts';
import { genCommand } from './commands/gen.command.ts';
import { applyCommand } from './commands/apply.command.ts';
import { delegateCommand } from './commands/delegate.command.ts';
import { groundingCommand } from './commands/grounding.command.ts';
import { planCheckCommand } from './commands/plan-check.command.ts';
import { whyCommand } from './commands/why.command.ts';
import {
  specParentCommand,
  specCreateCommand,
  specReviewCommand,
  specImplementCommand,
  specVerifyCommand,
  specListCommand,
  specShowCommand,
  specStatusCommand,
  specLintCommand,
} from './commands/spec.command.ts';
import { exportCommand } from './commands/export.command.ts';
import { dashboardCommand } from './commands/dashboard.command.ts';
import {
  dashboardDiffCommand,
  dashboardExportCommand,
} from './commands/dashboard-export.command.ts';
import { importCommand } from './commands/import.command.ts';
import { askCommand } from './commands/ask.command.ts';
import { aiStatusCommand } from './commands/ai-status.command.ts';
import {
  smartContextAuditKnowledgeCommand,
  smartContextAuditPipelinesCommand,
  smartContextAuditTemplatesCommand,
  smartContextCommand,
  smartContextEmbeddingsBuildCommand,
  smartContextEmbeddingsStatusCommand,
  smartContextListCommand,
  smartContextPlanAheadCommand,
  smartContextShowCommand,
} from './commands/smart-context.command.ts';
import { spikeCommand } from './commands/spike.command.ts';
import { depsAuditCommand } from './commands/deps-audit.command.ts';
import { scaffoldValidateCommand } from './commands/scaffold-validate.command.ts';
import { movePlanCommand } from './commands/move-plan.command.ts';
import { watchCommand, watchListCommand, watchPruneCommand, watchStopCommand } from './commands/watch.command.ts';
import { mcpCommand } from './commands/mcp.command.ts';
import { versionCommand } from './commands/version.command.ts';
import { changelogCommand } from './commands/changelog.command.ts';
import { makeHelpCommand } from './commands/help.command.ts';
import { qualityCommand } from './commands/quality.command.ts';
import { ciCommand } from './commands/ci.command.ts';
import { eslintCommand } from './commands/eslint.command.ts';
import { biomeCommand } from './commands/biome.command.ts';
import { ideCommand } from './commands/ide.command.ts';
import { makeCommandsCommand } from './commands/commands.command.ts';
import { safetyCommand } from './commands/safety.command.ts';
import { profilesCommand } from './commands/profiles.command.ts';
import { auditProjectCouplingCommand } from './commands/audit.command.ts';
import { conventionsCommand } from './commands/conventions.command.ts';
import { selfConfigCommand } from './commands/self-config.command.ts';
import { helperCommand } from './commands/helper.command.ts';
import { registryCommand } from './commands/registry.command.ts';
import { registrationsCommand } from './commands/registrations.command.ts';
import {
  boundariesListCommand,
  boundariesGetCommand,
  boundariesExplainCommand,
  boundariesInferCommand,
} from './commands/boundaries.command.ts';
import {
  scaffoldsListCommand,
  scaffoldsGetCommand,
  scaffoldsDoctorCommand,
} from './commands/scaffolds.command.ts';
import { inferCommand } from './commands/infer.command.ts';
import { reportCommand } from './commands/report.command.ts';
import { bundleCommand } from './commands/bundle.command.ts';
import { impactCommand } from './commands/impact.command.ts';
import { traceCommand } from './commands/trace.command.ts';
import { feedbackCommand } from './commands/feedback-dispatch.command.ts';
import { searchCommand, searchTuningListCommand } from './commands/search.command.ts';
import { briefCommand } from './commands/brief.command.ts';
import { releaseCommand, installSmokeCommand } from './commands/release.command.ts';
import { startHereCommand } from './commands/start-here.command.ts';
import { docsCheckCommand, examplesCheckCommand } from './commands/docs.command.ts';
import { selfAuditCommand } from './commands/self.command.ts';
import { diagnosticsListCommand } from './commands/diagnostics.command.ts';
import { architectureMapCommand } from './commands/architecture.command.ts';
import { orchestrateCommand } from './commands/orchestrate.command.ts';
import { simulateCommand } from './commands/simulate.command.ts';
import {
  reposetInitCommand,
  reposetListCommand,
  reposetDoctorCommand,
  reposetMapCommand,
} from './commands/reposet.command.ts';
import { recommendCommand } from './commands/recommend.command.ts';
import { surfaceCommand } from './commands/surface.command.ts';
import { upgradeCheckCommand, upgradePlanCommand } from './commands/upgrade.command.ts';
import {
  architectureViolationsCommand,
  architectureAreaCommand,
} from './commands/architecture.command.ts';
import { riskCommand } from './commands/risk.command.ts';
import { contractCommand } from './commands/contract.command.ts';
import {
  contractApproveCommand,
  contractCheckCommand,
  contractStatusCommand,
} from './commands/contract-gate.command.ts';
import { planSimulateCommand } from './commands/plan-simulate.command.ts';
import {
  memoryBuildCommand,
  memoryDiagnosticsCommand,
  memoryDiffCommand,
  memoryDriftCommand,
  memoryFilesCommand,
  memoryReportCommand,
  memoryResetCommand,
  memoryRiskCommand,
  memorySnapshotsCommand,
} from './commands/memory.command.ts';
import {
  constructsAdoptCommand,
  constructsApiCommand,
  constructsEventsCommand,
  constructsFacetsCommand,
  constructsFilesCommand,
  constructsGetCommand,
  constructsImpactCommand,
  constructsInferCommand,
  constructsListCommand,
  constructsRelatedCommand,
  constructsSearchCommand,
  constructsTokensCommand,
  constructsTraceCommand,
} from './commands/constructs.command.ts';
import {
  playbooksBriefCommand,
  playbooksGetCommand,
  playbooksListCommand,
  playbooksPreviewCommand,
  playbooksRecommendCommand,
  playbooksRunbookCommand,
  playbooksScriptCommand,
  playbooksValidateCommand,
} from './commands/playbooks.command.ts';
import { repoAreasCommand } from './commands/repo.command.ts';
import {
  policyCheckCommand,
  policyListCommand,
  policyGetCommand,
  policySnapshotCommand,
  policyTestCommand,
  policyRunCommand,
} from './commands/policy.command.ts';
import { ownersListCommand, ownersMatchCommand, ownersImpactCommand } from './commands/owners.command.ts';
import {
  ownershipListCommand,
  ownershipForCommand,
  ownershipAffectedCommand,
} from './commands/ownership.command.ts';
import { runtimeDoctorCommand } from './commands/runtime.command.ts';
import { testsImpactCommand, testsSuggestCommand, testsMissingCommand } from './commands/tests.command.ts';
import {
  gitChangedCommand,
  gitRootCommand,
  gitBranchCommand,
  gitStatusSummaryCommand,
} from './commands/git.command.ts';
import {
  templatesLintCommand,
  templatesTestCommand,
  templatesSnapshotCommand,
} from './commands/template-quality.command.ts';
import { boundariesEnforceCommand, boundariesSuggestCommand } from './commands/boundaries.command.ts';
import { languagesCommand } from './commands/languages.command.ts';
import { fixCommand } from './commands/fix.command.ts';
// unified lint aggregator.
import { lintCommand } from './commands/lint.command.ts';
import { changesCommand } from './commands/changes.command.ts';
import { exploreCommand } from './commands/explore.command.ts';
import { prCommand } from './commands/pr.command.ts';
import { completionCommand } from './commands/completion.command.ts';
import { codeIntelCommand } from './commands/code-intel.command.ts';
import { suggestDidYouMean } from '@shrkcrft/inspector';
import { COMMAND_CATALOG } from './commands/command-catalog.ts';
import { errorFooterFor, renderErrorFooter } from './output/failure-hints.ts';
import { renderAbout } from './surface/about.ts';
import { renderNoArgsLanding } from './surface/no-args-landing.ts';
import { loadSurfaceContext } from './surface/load-surface-context.ts';
import { buildSurfaceSummary, findCommandInSummary } from './surface/surface-summary.ts';
import {
  makeSurfaceNotEnabledError,
  renderSurfaceNotEnabledText,
  SURFACE_NOT_ENABLED_EXIT_CODE,
} from './surface/not-enabled-error.ts';
import {
  extractCommandPath,
  recordUsage,
  sanitizeFlagNames,
} from './usage/usage-log.ts';
import { loadProjectConfig } from '@shrkcrft/config';

export function buildRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  registry.register(initCommand);
  registry.register(inspectCommand);
  registry.register(doctorCommand);
  registry.register(aiStatusCommand);
  registry.registerSubcommand('doctor', doctorSuppressCommand);
  registry.registerSubcommand('doctor', doctorSuppressionsCommand);
  // Acknowledgements with required reason + expiry.
  registry.registerSubcommand('doctor', doctorAcknowledgeCommand);
  registry.registerSubcommand('doctor', doctorAcknowledgementsCommand);
  registry.register(contextCommand);
  registry.register(genCommand);
  registry.register(applyCommand);
  registry.register(delegateCommand);
  // `shrk grounding` thin context primer.
  registry.register(groundingCommand);
  // feedback3 — `shrk why <file>` (closes the dangling ide-suggested verb).
  registry.register(whyCommand);
  // spec verb + subcommands.
  registry.register(specParentCommand);
  registry.registerSubcommand('spec', specCreateCommand);
  registry.registerSubcommand('spec', specReviewCommand);
  registry.registerSubcommand('spec', specImplementCommand);
  registry.registerSubcommand('spec', specVerifyCommand);
  registry.registerSubcommand('spec', specListCommand);
  registry.registerSubcommand('spec', specShowCommand);
  registry.registerSubcommand('spec', specStatusCommand);
  registry.registerSubcommand('spec', specLintCommand);
  // rounds capture + diff.
  registry.register(roundsParentCommand);
  registry.registerSubcommand('rounds', roundsCaptureCommand);
  registry.registerSubcommand('rounds', roundsListCommand);
  registry.registerSubcommand('rounds', roundsShowCommand);
  registry.register(diffParentCommand);
  registry.registerSubcommand('diff', diffRoundsCommand);
  registry.register(exportCommand);
  registry.register(dashboardCommand);
  registry.registerSubcommand('dashboard', dashboardExportCommand);
  registry.registerSubcommand('dashboard', dashboardDiffCommand);
  registry.register(importCommand);
  registry.register(taskCommand);
  registry.register(explainCommand);
  registry.register(checkCommand);
  registry.register(diffCheckCommand);
  registry.register(finishCommand);
  // changed-only preflight orchestrator.
  registry.register(preflightCommand);
  registry.register(driftCommand);
  registry.register(graphCommand);
  registry.register(ruleGraphCommand);
  registry.register(searchStructuralCommand);
  registry.register(planContextCommand);
  registry.register(archCommand);
  registry.register(frameworkCommand);
  registry.register(apiDiffCommand);
  registry.register(gateCommand);
  registry.register(policyLintCommand);
  registry.register(wiringCommand);
  registry.register(reuseCommand);
  registry.register(migrateCommand);
  registry.register(coverageCommand);
  registry.register(statsCommand);
  registry.register(compressCommand);
  registry.register(expandCommand);
  registry.register(alignCommand);
  registry.register(unalignCommand);
  registry.register(reviewCommand);
  registry.register(onboardCommand);
  registry.register(ingestCommand);
  registry.register(contradictionsCommand);
  registry.register(generatedCommand);
  registry.register(understandTaskCommand);
  registry.register(validateChangeCommand);
  // contextBuildCommand / contextRefreshCommand / contextStatusCommand are
  // dispatched from inside contextCommand based on the first positional arg
  // (avoids breaking `shrk context --task "..."` flat usage).
  void contextBuildCommand;
  void contextRefreshCommand;
  void contextStatusCommand;
  registry.register(testCommand);
  registry.register(planParentCommand);
  registry.register(devCommand);
  registry.register(askCommand);
  registry.register(smartContextCommand);
  registry.registerSubcommand('smart-context', smartContextPlanAheadCommand);
  registry.registerSubcommand('smart-context', smartContextListCommand);
  registry.registerSubcommand('smart-context', smartContextShowCommand);
  registry.registerSubcommand('smart-context', smartContextEmbeddingsBuildCommand);
  registry.registerSubcommand('smart-context', smartContextEmbeddingsStatusCommand);
  registry.registerSubcommand('smart-context', smartContextAuditTemplatesCommand);
  registry.registerSubcommand('smart-context', smartContextAuditKnowledgeCommand);
  registry.registerSubcommand('smart-context', smartContextAuditPipelinesCommand);
  registry.register(spikeCommand);
  registry.register(depsAuditCommand);
  registry.register(scaffoldValidateCommand);
  registry.register(movePlanCommand);
  registry.register(watchCommand);
  registry.registerSubcommand('watch', watchListCommand);
  registry.registerSubcommand('watch', watchStopCommand);
  registry.registerSubcommand('watch', watchPruneCommand);
  registry.register(mcpCommand);
  registry.register(versionCommand);
  registry.register(changelogCommand);
  registry.register(qualityCommand);
  registry.register(ciCommand);
  registry.register(eslintCommand);
  registry.register(biomeCommand);
  registry.register(ideCommand);
  registry.register(profilesCommand);
  registry.registerSubcommand('audit', auditProjectCouplingCommand);
  registry.register(conventionsCommand);
  registry.register(selfConfigCommand);
  registry.register(helperCommand);
  registry.register(registryCommand);
  registry.register(registrationsCommand);
  registry.register(makeCommandsCommand(registry));
  registry.register(safetyCommand);
  registry.register(inferCommand);
  registry.register(reportCommand);
  registry.register(bundleCommand);
  registry.register(impactCommand);
  registry.register(traceCommand);
  registry.register(feedbackCommand);
  registry.register(fixCommand);
  // unified lint verb (knowledge / rules / templates aggregator).
  registry.register(lintCommand);
  registry.register(changesCommand);
  registry.register(prCommand);
  registry.register(completionCommand);
  registry.register(codeIntelCommand);
  registry.register(searchCommand);
  registry.register(briefCommand);
  registry.register(releaseCommand);
  registry.register(startHereCommand);
  registry.register(exploreCommand);
  registry.register(orchestrateCommand);
  registry.register(simulateCommand);
  registry.register(recommendCommand);
  // Adaptive surface introspection + management.
  registry.register(surfaceCommand);
  registry.register(riskCommand);
  registry.register(contractCommand);
  // contract gates — dispatched from inside contractCommand when the
  // first positional is check/approve/status (avoids subcommand-routing
  // collision with the task-string form `shrk contract "<task>"`).
  void contractCheckCommand;
  void contractApproveCommand;
  void contractStatusCommand;
  registry.registerSubcommand('plan', planSimulateCommand);
  // register `plan review` as a proper subcommand so the catalog
  // and registry agree. The internal dispatch in planParentCommand still
  // works (acts as a fallback for direct invocation), but the canonical
  // wire-up is now explicit.
  registry.registerSubcommand('plan', planReviewCommand);
  // `shrk plan check <path>` validates external plans.
  registry.registerSubcommand('plan', planCheckCommand);
  registry.registerSubcommand('memory', memoryBuildCommand);
  registry.registerSubcommand('memory', memoryReportCommand);
  registry.registerSubcommand('memory', memoryRiskCommand);
  registry.registerSubcommand('memory', memoryFilesCommand);
  registry.registerSubcommand('memory', memoryDiagnosticsCommand);
  registry.registerSubcommand('memory', memoryResetCommand);
  registry.registerSubcommand('memory', memoryDiffCommand);
  registry.registerSubcommand('memory', memoryDriftCommand);
  registry.registerSubcommand('memory', memorySnapshotsCommand);
  registry.register(languagesCommand);

  registry.registerSubcommand('docs', docsCheckCommand);
  registry.registerSubcommand('examples', examplesCheckCommand);
  registry.registerSubcommand('self', selfAuditCommand);
  registry.registerSubcommand('install', installSmokeCommand);
  registry.registerSubcommand('diagnostics', diagnosticsListCommand);
  registry.registerSubcommand('architecture', architectureMapCommand);
  registry.registerSubcommand('architecture', architectureViolationsCommand);
  registry.registerSubcommand('architecture', architectureAreaCommand);
  registry.registerSubcommand('reposet', reposetInitCommand);
  registry.registerSubcommand('reposet', reposetListCommand);
  registry.registerSubcommand('reposet', reposetDoctorCommand);
  registry.registerSubcommand('reposet', reposetMapCommand);
  registry.registerSubcommand('upgrade', upgradeCheckCommand);
  registry.registerSubcommand('upgrade', upgradePlanCommand);

  registry.registerSubcommand('boundaries', boundariesListCommand);
  registry.registerSubcommand('boundaries', boundariesGetCommand);
  registry.registerSubcommand('boundaries', boundariesExplainCommand);
  registry.registerSubcommand('boundaries', boundariesInferCommand);
  registry.registerSubcommand('boundaries', boundariesSuggestCommand);
  registry.registerSubcommand('boundaries', boundariesEnforceCommand);

  registry.registerSubcommand('repo', repoAreasCommand);

  registry.registerSubcommand('policy', policyListCommand);
  registry.registerSubcommand('policy', policyGetCommand);
  registry.registerSubcommand('policy', policyTestCommand);
  registry.registerSubcommand('policy', policyRunCommand);
  registry.registerSubcommand('policy', policyCheckCommand);
  registry.registerSubcommand('policy', policySnapshotCommand);

  registry.registerSubcommand('owners', ownersListCommand);
  registry.registerSubcommand('owners', ownersMatchCommand);
  registry.registerSubcommand('owners', ownersImpactCommand);

  registry.registerSubcommand('ownership', ownershipListCommand);
  registry.registerSubcommand('ownership', ownershipForCommand);
  registry.registerSubcommand('ownership', ownershipAffectedCommand);

  registry.registerSubcommand('runtime', runtimeDoctorCommand);

  registry.registerSubcommand('constructs', constructsListCommand);
  registry.registerSubcommand('constructs', constructsGetCommand);
  registry.registerSubcommand('constructs', constructsTraceCommand);
  registry.registerSubcommand('constructs', constructsApiCommand);
  registry.registerSubcommand('constructs', constructsEventsCommand);
  registry.registerSubcommand('constructs', constructsTokensCommand);
  registry.registerSubcommand('constructs', constructsFacetsCommand);
  registry.registerSubcommand('constructs', constructsSearchCommand);
  registry.registerSubcommand('constructs', constructsInferCommand);
  registry.registerSubcommand('constructs', constructsAdoptCommand);
  registry.registerSubcommand('constructs', constructsImpactCommand);
  registry.registerSubcommand('constructs', constructsRelatedCommand);
  registry.registerSubcommand('constructs', constructsFilesCommand);

  registry.registerSubcommand('playbooks', playbooksListCommand);
  registry.registerSubcommand('playbooks', playbooksGetCommand);
  registry.registerSubcommand('playbooks', playbooksRecommendCommand);
  registry.registerSubcommand('playbooks', playbooksRunbookCommand);
  registry.registerSubcommand('playbooks', playbooksBriefCommand);
  registry.registerSubcommand('playbooks', playbooksScriptCommand);
  registry.registerSubcommand('playbooks', playbooksPreviewCommand);
  registry.registerSubcommand('playbooks', playbooksValidateCommand);
  registry.aliasGroup('construct', 'constructs');
  registry.aliasGroup('playbook', 'playbooks');

  registry.registerSubcommand('tests', testsImpactCommand);
  registry.registerSubcommand('tests', testsSuggestCommand);
  registry.registerSubcommand('tests', testsMissingCommand);

  registry.registerSubcommand('git', gitChangedCommand);
  registry.registerSubcommand('git', gitRootCommand);
  registry.registerSubcommand('git', gitBranchCommand);
  registry.registerSubcommand('git', gitStatusSummaryCommand);

  registry.registerSubcommand('templates', templatesLintCommand);
  registry.registerSubcommand('templates', templatesTestCommand);
  registry.registerSubcommand('templates', templatesSnapshotCommand);

  registry.registerSubcommand('knowledge', knowledgeListCommand);
  registry.registerSubcommand('knowledge', knowledgeGetCommand);
  registry.registerSubcommand('knowledge', knowledgeSearchCommand);
  registry.registerSubcommand('knowledge', knowledgeStaleCheckCommand);
  registry.registerSubcommand('knowledge', knowledgeVerifyCommand);
  registry.registerSubcommand('knowledge', knowledgeReferencesCommand);
  registry.registerSubcommand('knowledge', knowledgeAnchorsCommand);
  registry.registerSubcommand('knowledge', knowledgeRenameSymbolCommand);
  registry.registerSubcommand('knowledge', knowledgeRenameFileCommand);
  registry.registerSubcommand('knowledge', knowledgeUpdateAnchorCommand);
  // knowledge authoring preview surface.
  registry.registerSubcommand('knowledge', knowledgeAddCommand);
  registry.registerSubcommand('knowledge', knowledgeUpdateCommand);
  registry.registerSubcommand('knowledge', knowledgeRemoveCommand);
  registry.registerSubcommand('knowledge', knowledgeLintCommand);
  // propose stub entries for uncovered exports (AST-driven).
  registry.registerSubcommand('knowledge', knowledgeProposeCommand);

  registry.registerSubcommand('rules', rulesListCommand);
  registry.registerSubcommand('rules', rulesGetCommand);
  registry.registerSubcommand('rules', rulesRelevantCommand);
  registry.registerSubcommand('rules', rulesScaffoldCommand);
  // `rules update` thin wrapper over knowledge update.
  registry.registerSubcommand('rules', rulesUpdateCommand);
  // authoring symmetry: rules add / rules remove (parity with knowledge).
  registry.registerSubcommand('rules', rulesAddCommand);
  registry.registerSubcommand('rules', rulesRemoveCommand);
  registry.registerSubcommand('rules', rulesDoctorCommand);
  registry.registerSubcommand('rules', rulesLintCommand);

  // custom checks registry.
  registry.registerSubcommand('checks', checksListCommand);
  registry.registerSubcommand('checks', checksDoctorCommand);
  registry.registerSubcommand('checks', checksRunCommand);
  registry.registerSubcommand('checks', checksParseReportCommand);
  // universal check-result protocol.
  registry.registerSubcommand('checks', checksImportCommand);
  registry.registerSubcommand('checks', checksAggregateCommand);
  registry.registerSubcommand('checks', checksReportCommand);
  registry.registerSubcommand('checks', checksConvertCommand);

  // codemod-assist (NOT a codemod engine).
  registry.register(codemodCommand);

  registry.registerSubcommand('paths', pathsListCommand);
  registry.registerSubcommand('paths', pathsGetCommand);
  registry.registerSubcommand('paths', pathsSearchCommand);
  registry.registerSubcommand('paths', pathsBestCommand);

  registry.registerSubcommand('templates', templatesListCommand);
  registry.registerSubcommand('templates', templatesGetCommand);
  registry.registerSubcommand('templates', templatesSearchCommand);
  registry.registerSubcommand('templates', templatesPreviewCommand);
  registry.registerSubcommand('templates', templatesVarsCommand);
  registry.registerSubcommand('templates', templatesDriftCommand);
  registry.registerSubcommand('templates', templatesVerifyPathsCommand);
  registry.registerSubcommand('templates', templatesSmokeCommand);
  // authoring stack: scaffold / add / doctor.
  registry.registerSubcommand('templates', templatesScaffoldCommand);
  registry.registerSubcommand('templates', templatesAddCommand);
  registry.registerSubcommand('templates', templatesDoctorCommand);
  // authoring parity: update / remove.
  registry.registerSubcommand('templates', templatesUpdateCommand);
  registry.registerSubcommand('templates', templatesRemoveCommand);

  registry.registerSubcommand('pipelines', pipelinesListCommand);
  registry.registerSubcommand('pipelines', pipelinesGetCommand);
  registry.registerSubcommand('pipelines', pipelinesContextCommand);
  registry.registerSubcommand('pipelines', pipelinesPlanCommand);
  registry.registerSubcommand('pipelines', pipelinesScriptCommand);
  registry.registerSubcommand('pipelines', pipelinesNextCommand);
  registry.registerSubcommand('pipelines', pipelinesVarsCommand);

  registry.registerSubcommand('packs', packsListCommand);
  registry.registerSubcommand('packs', packsContributionsCommand);
  registry.registerSubcommand('packs', packsConflictsCommand);
  registry.registerSubcommand('packs', packsSignatureStatusCommand);
  registry.registerSubcommand('packs', packsGetCommand);
  registry.registerSubcommand('packs', packsInspectCommand);
  registry.registerSubcommand('packs', packsDoctorCommand);
  registry.registerSubcommand('packs', packsSignCommand);
  registry.registerSubcommand('packs', packsVerifyCommand);
  registry.registerSubcommand('packs', packsNewCommand);
  registry.registerSubcommand('packs', packsTestCommand);
  registry.registerSubcommand('packs', packsReleaseCheckCommand);
  registry.registerSubcommand('packs', packsCompatCommand);
  registry.registerSubcommand('packs', packsDevStatusCommand);
  registry.registerSubcommand('packs', packsWatchCommand);

  // pack authoring moved to a 3-level group: `shrk pack author <verb>`.
  // The old `pack-author <verb>` shape is gone (no backward-compat shim).
  // `shrk packs pending` survives as a convenience for the pending view.
  registry.registerAt(['pack', 'author', packAuthorStatusCommand.name], packAuthorStatusCommand);
  registry.registerAt(['pack', 'author', packAuthorPreviewCommand.name], packAuthorPreviewCommand);
  registry.registerAt(['pack', 'author', packAuthorPendingCommand.name], packAuthorPendingCommand);
  registry.registerAt(['pack', 'author', packAuthorValidateCommand.name], packAuthorValidateCommand);
  registry.registerSubcommand('packs', packAuthorPendingCommand);

  // provenance ledger CLI.
  registry.registerSubcommand('provenance', provenanceListCommand);
  registry.registerSubcommand('provenance', provenanceShowCommand);
  registry.registerSubcommand('provenance', provenanceReportCommand);
  // missing / doctor verbs.
  registry.registerSubcommand('provenance', provenanceMissingCommand);
  registry.registerSubcommand('provenance', provenanceDoctorCommand);

  registry.registerSubcommand('schemas', schemasListCommand);
  registry.registerSubcommand('schemas', schemasGetCommand);
  registry.registerSubcommand('schemas', schemasInventoryCommand);
  registry.registerSubcommand('schemas', schemasWriteCommand);
  // preview-first emission + preflight drift check.
  registry.registerSubcommand('schemas', schemasEmitCommand);

  registry.registerSubcommand('scaffolds', scaffoldsListCommand);
  registry.registerSubcommand('scaffolds', scaffoldsGetCommand);
  registry.registerSubcommand('scaffolds', scaffoldsDoctorCommand);

  registry.registerSubcommand('presets', presetsListCommand);
  registry.registerSubcommand('presets', presetsGetCommand);
  registry.registerSubcommand('presets', presetsExplainCommand);
  registry.registerSubcommand('presets', presetsRecommendCommand);
  registry.registerSubcommand('presets', presetsPreviewCommand);
  registry.registerSubcommand('presets', presetsApplyCommand);
  registry.registerSubcommand('presets', presetsDoctorCommand);
  registry.registerSubcommand('presets', presetsDiffCommand);
  registry.registerSubcommand('presets', presetsPatchCommand);

  // release subcommand additions — register under 'release' group via 'train'.
  // We pass 'train' as the canonical name; users invoke `shrk release train <verb>`.
  // Convenience aliases so users can say either form.
  registry.aliasGroup('pipeline', 'pipelines');
  registry.aliasGroup('schema', 'schemas');
  registry.aliasGroup('preset', 'presets');
  registry.aliasGroup('scaffold', 'scaffolds');

  const help = makeHelpCommand(registry);
  registry.register(help as ICommandHandler);
  return registry;
}

export async function runCli(argv: readonly string[]): Promise<number> {
  const usageStart = performance.now();
  const { cwd: probeCwd, rest: probeArgv } = extractGlobalCwd(argv);
  let exitCode = 0;
  try {
    exitCode = await runCliInner(argv);
    return exitCode;
  } finally {
    // append one local usage entry. Failure is silent.
    try {
      const command = extractCommandPath(probeArgv);
      if (command.length > 0) {
        const flags = sanitizeFlagNames(probeArgv);
        const enabled = await isUsageEnabled(probeCwd ?? process.cwd());
        recordUsage({
          cwd: probeCwd ?? process.cwd(),
          command,
          exitCode,
          durationMs: performance.now() - usageStart,
          flags,
          enabled,
        });
      }
    } catch {
      // ignore — usage log must never fail the CLI
    }
  }
}

/**
 * Resolve whether the local usage log is enabled. Order:
 *   1. `SHARKCRAFT_USAGE_DISABLED=1` env → false (disabled).
 *   2. `sharkcraft.config.ts usage.enabled === false` → false.
 *   3. Otherwise → true.
 */
async function isUsageEnabled(cwd: string): Promise<boolean> {
  if (process.env.SHARKCRAFT_USAGE_DISABLED === '1') return false;
  try {
    const result = await loadProjectConfig(cwd);
    if (!result.ok) return true;
    return result.value.config.usage?.enabled !== false;
  } catch {
    return true;
  }
}

async function runCliInner(argv: readonly string[]): Promise<number> {
  const registry = buildRegistry();

  // Pre-parse the global --cwd so it can appear anywhere (incl. before the command).
  const { cwd: globalCwd, rest: cwdCleanArgv } = extractGlobalCwd(argv);
  // Pre-parse the global --compress / --ccr output-compression flags.
  const { directive: compressDirective, rest: cleanArgv } = extractGlobalCompress(cwdCleanArgv);
  const [first] = cleanArgv;

  // `--compress` / `--ccr` on a real command: re-run it and compress its stdout.
  // (Meta verbs like --help/--version and bare invocations are left untouched.)
  if (
    compressDirective &&
    first &&
    first !== '--help' &&
    first !== '-h' &&
    first !== '--full-help' &&
    first !== '--version' &&
    first !== '-v' &&
    first !== '--about'
  ) {
    const childArgv = globalCwd ? ['--cwd', globalCwd, ...cleanArgv] : [...cleanArgv];
    return runCommandWithCompression(childArgv, compressDirective, globalCwd ?? process.cwd());
  }

  // bare invocation lands on the curated tiered view.
  if (!first) {
    const landing = await renderNoArgsLanding(globalCwd ?? process.cwd());
    process.stdout.write(landing);
    return 0;
  }
  // Top-level meta flags.
  if (first === '--help' || first === '-h') {
    return registry.get('help')!.run(parseArgs([], { globalCwd }));
  }
  if (first === '--full-help') {
    // Pass through `--all` (catalog dump) and `--verbose` if the user
    // included them after `--full-help`.
    const extra: string[] = [];
    if (argv.includes('--all')) extra.push('--all');
    if (argv.includes('--verbose') || argv.includes('-v')) extra.push('--verbose');
    return registry.get('help')!.run(parseArgs(['--full', ...extra], { globalCwd }));
  }
  if (first === '--version' || first === '-v') {
    return registry.get('version')!.run(parseArgs([], { globalCwd }));
  }
  // `shrk --about` prints the in-binary philosophy summary.
  if (first === '--about') {
    process.stdout.write(renderAbout());
    return 0;
  }

  // greedy trie descent. Handles 1-, 2-, and 3-level commands uniformly
  // (`shrk doctor`, `shrk packs list`, `shrk pack author status`). The
  // resolver stops when it hits a flag or a token that isn't a child of the
  // current node, returning the deepest handler + the leftover tokens.
  let { handler, matchedPath, rest: leftover, node } = registry.resolve(cleanArgv);

  // A multi-word command passed as a SINGLE quoted token (`shrk "graph status"`)
  // arrives as one argv element with internal whitespace. The trie has no atomic
  // `graph status` node, so the first descent misses (handler undefined) — yet
  // did-you-mean would still list `graph status` as the #1 closest match, a
  // self-contradiction. Re-split the lone token on whitespace and retry so the
  // quoted form behaves identically to the unquoted `shrk graph status`.
  // Genuinely unknown tokens leave `handler` undefined and fall through to the
  // existing unknown-command path unchanged.
  if (!handler && cleanArgv.length === 1 && /\s/.test(cleanArgv[0]!)) {
    const retry = registry.resolve(cleanArgv[0]!.trim().split(/\s+/));
    if (retry.handler) {
      ({ handler, matchedPath, rest: leftover, node } = retry);
    }
  }

  // `--help` / `-h` immediately after a (sub)group → render help for that
  // path. This works at any depth.
  if (leftover[0] === '--help' || leftover[0] === '-h') {
    return registry.get('help')!.run(parseArgs([matchedPath.join(' ')], { globalCwd }));
  }

  if (handler) {
    // gate experimental commands. Bootstrap commands and core/extended
    // tiers pass through; experimental commands return the structured
    // not-enabled error unless `surface.enabled[]` contains them.
    const gateReason = await checkSurfaceGate(matchedPath, globalCwd ?? process.cwd());
    if (gateReason) {
      const err = makeSurfaceNotEnabledError(gateReason.command, { reason: gateReason.detail });
      process.stderr.write(renderSurfaceNotEnabledText(err));
      return SURFACE_NOT_ENABLED_EXIT_CODE;
    }
    return await handler.run(
      parseArgs(leftover, { globalCwd, booleanFlags: handler.booleanFlags }),
    );
  }

  // No handler at the deepest match. If we landed on a group node (has
  // children), show that group's help so the user discovers the verbs.
  if (matchedPath.length > 0 && node.children.size > 0) {
    return registry.get('help')!.run(parseArgs([matchedPath.join(' ')], { globalCwd }));
  }

  // Genuinely unknown — fall back to free-form / did-you-mean.
  const probe = cleanArgv.filter(
    (t): t is string => typeof t === 'string' && t.length > 0 && !t.startsWith('-'),
  );
  if (looksLikeFreeFormTask(probe)) {
    printFreeFormTaskHint(probe.join(' '));
    return 2;
  }
  const attempted = probe.slice(0, 2).join(' ');
  process.stderr.write(`shrk doesn't have a \`${attempted}\` command.\n`);
  printDidYouMean(attempted);
  return 2;
}

/**
 * Heuristic for "this looks like a task, not a command".
 *
 *  - At least two non-flag tokens (commands have at most two tokens: a
 *    top-level + a subcommand verb).
 *  - Or one token that matches a known free-form verb (rename / add / fix /
 *    refactor / remove / migrate / implement / update / build / …).
 *  - Never matches `--`-prefixed flag tokens.
 *
 * The function is deterministic and accepts only positional tokens.
 * Exported for tests.
 */
export function looksLikeFreeFormTask(tokens: readonly string[]): boolean {
  // Flatten on internal whitespace so the canonical *quoted* form
  // (`shrk "refactor the auth module"`) — which the shell delivers as ONE argv
  // element — is counted by word, exactly like the unquoted multi-token form.
  // Without this, the documented quoted form was a single token (length 1) and
  // fell through to the did-you-mean matcher instead of routing to `recommend`.
  const clean = tokens
    .filter((t) => t.length > 0 && !t.startsWith('-'))
    .flatMap((t) => t.trim().split(/\s+/))
    .filter((w) => w.length > 0);
  if (clean.length < 2) return false;
  // 3+ tokens is almost always a sentence, not a command — `shrk` only has
  // 2 levels (top + sub), so anything beyond that has no chance of being a
  // real path.
  if (clean.length >= 3) return true;
  // 2 tokens: only treat as a task if the first token is a recognisable
  // task verb. Otherwise it's plausibly a typo of a subcommand and we let
  // the regular did-you-mean handle it.
  const verbs = new Set([
    'rename',
    'add',
    'fix',
    'refactor',
    'remove',
    'delete',
    'migrate',
    'wire',
    'create',
    'implement',
    'update',
    'introduce',
    'build',
    'extract',
    'move',
    'inline',
    'generate',
    'scaffold',
    'explain',
    'document',
    'review',
    'test',
    'design',
    'refresh',
    'reorganise',
    'reorganize',
    'restructure',
    'split',
    'merge',
    'reduce',
    'simplify',
  ]);
  return verbs.has(clean[0]!.toLowerCase());
}

function printFreeFormTaskHint(task: string): void {
  process.stderr.write(
    `\nThis looks like a task, not a command.\n` +
      `\n` +
      `Recommended:\n` +
      `  $ shrk recommend "${task}"\n` +
      `\n` +
      `Why:\n` +
      `  \`shrk recommend\` is the canonical human entrypoint for "what should I do?".\n` +
      `\n` +
      `More detail:\n` +
      `  $ shrk start-here\n` +
      `  $ shrk commands\n`,
  );
}

/**
 * Check whether the resolved command path is gated by the
 * surface tier model. Returns `null` if the command is callable
 * (core/extended), or `{ command, detail }` if it is an experimental
 * command not enabled in the current repo's surface config.
 *
 * Failure-soft: any error loading the inspection (fresh repo, no
 * config, etc.) lets the command through. The gate must NEVER false-
 * positive a bootstrap call — the bootstrap set in `tier.ts` plus
 * spine-derived core commands always pass through cleanly.
 */
async function checkSurfaceGate(
  matchedPath: readonly string[],
  cwd: string,
): Promise<{ command: string; detail?: string } | null> {
  const candidate = matchedPath.join(' ');
  if (candidate.length === 0) return null;
  try {
    const { context } = await loadSurfaceContext({ cwd });
    const summary = buildSurfaceSummary(context);
    // Try the full path first; fall back to the top-level token. The
    // catalog uses both shapes ("doctor" and "plan review").
    const view =
      findCommandInSummary(summary, candidate) ??
      findCommandInSummary(summary, matchedPath[0] ?? '');
    if (!view) return null;
    if (view.callable) return null;
    return { command: view.command, detail: view.detail };
  } catch {
    return null;
  }
}

// Score thresholds for did-you-mean output. Picked from observed
// scoring: 1-char-off typos score 8+ on plain commands; 3-4-char-off
// near-misses score ~5; loose / token-overlap matches score 1-3.
// Junk matches (frobnicate → bundle diff) can score 8 too because of
// token overlap, so we sharpen by also requiring the suggestion's
// command name to be reasonably close in length to the attempt.
const SUGGEST_CONFIDENT_SCORE = 7;
const SUGGEST_VISIBLE_SCORE = 3;

function reorderCandidates<T extends { command: string; score: number }>(
  attempted: string,
  candidates: readonly T[],
): T[] {
  // Stable sort: higher score first, then shorter command (more likely
  // canonical), then lexicographic. The base suggester returns ties in
  // arbitrary order — this makes the top suggestion more predictable.
  const ranked = [...candidates];
  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.command.length !== b.command.length) {
      return a.command.length - b.command.length;
    }
    return a.command < b.command ? -1 : a.command > b.command ? 1 : 0;
  });
  return ranked;
}

/** Edit distance (Levenshtein). Used to gate did-you-mean confidence. */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[] = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) dp[j] = j;
  for (let i = 1; i <= m; i += 1) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const tmp = dp[j]!;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + cost);
      prev = tmp;
    }
  }
  return dp[n]!;
}

/**
 * Suggestion is "confident" when the candidate's top token is close
 * to the attempt in edit-distance terms — `doctorz`→`doctor` (1 edit)
 * or `inspct`→`inspect` (1 edit) qualify; `frobnicate`→`bundle` (10
 * edits) does not, even when the suggester scores them similarly
 * because of incidental token overlap in descriptions.
 *
 * Threshold: edit distance ≤ max(1, attempt.length / 4) AND raw score
 * meets `SUGGEST_VISIBLE_SCORE`. This catches typical fingers-on-keys
 * typos while rejecting "you typed something totally different."
 */
function isConfidentMatch(attempted: string, suggestion: { command: string; score: number }): boolean {
  if (suggestion.score < SUGGEST_VISIBLE_SCORE) return false;
  const lower = attempted.toLowerCase();
  const head = (suggestion.command.split(/\s+/)[0] ?? suggestion.command).toLowerCase();
  const dist = editDistance(lower, head);
  const tolerance = Math.max(1, Math.floor(lower.length / 4));
  return dist <= tolerance;
}

function printDidYouMean(attempted: string): void {
  const rawCandidates = suggestDidYouMean(COMMAND_CATALOG, [attempted], 5);
  const reordered = reorderCandidates(attempted, rawCandidates).filter(
    (c) => c.score >= SUGGEST_VISIBLE_SCORE,
  );

  if (reordered.length === 0) {
    process.stderr.write(
      'Run `shrk help` to see the curated commands, or `shrk --full-help` for the full catalog.\n',
    );
    const footer = errorFooterFor('unknown-command', { task: attempted });
    if (footer) process.stderr.write(renderErrorFooter(footer));
    return;
  }

  // Confident single-match path: surface ONE suggestion clearly.
  const top = reordered[0]!;
  if (isConfidentMatch(attempted, top)) {
    process.stderr.write(`Did you mean \`shrk ${top.command}\`?\n`);
    process.stderr.write(`  ${top.description}\n`);
    // Second-tier suggestions only if they're also strong.
    const others = reordered.slice(1, 3).filter((c) => isConfidentMatch(attempted, c));
    if (others.length > 0) {
      process.stderr.write('Other close matches:\n');
      for (const c of others) {
        process.stderr.write(`  shrk ${c.command} — ${c.description}\n`);
      }
    }
    const footer = errorFooterFor('unknown-command', { task: attempted });
    if (footer) process.stderr.write(renderErrorFooter(footer));
    return;
  }

  // Low-confidence: show up to 3 as "closest matches", honest about
  // not knowing which is right.
  process.stderr.write('Closest matches in the catalog:\n');
  for (const c of reordered.slice(0, 3)) {
    process.stderr.write(`  shrk ${c.command} — ${c.description}\n`);
  }
  process.stderr.write(
    "If none of those look right, run `shrk help` or `shrk \"<task>\"` to route as a free-form task.\n",
  );
  const footer = errorFooterFor('unknown-command', { task: attempted });
  if (footer) process.stderr.write(renderErrorFooter(footer));
}

/**
 * Point fd 2 (stderr) at a log file so native-runtime teardown noise written
 * during process exit lands in a file instead of the user's terminal. Returns
 * silently on any failure (the worst case is the pre-existing noisy stderr).
 *
 * The log path can be overridden with `SHRK_NATIVE_TEARDOWN_LOG`; default is
 * `<tmpdir>/shrk-native-teardown.log`. We append, with a timestamped header,
 * so the trace is recoverable for debugging without ever touching the console.
 */
async function redirectStderrToTeardownLog(): Promise<void> {
  try {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const logPath =
      process.env.SHRK_NATIVE_TEARDOWN_LOG?.trim() ||
      path.join(os.tmpdir(), 'shrk-native-teardown.log');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    // Close fd 2; the next open() reclaims the lowest free descriptor (2),
    // so all subsequent stderr — including native C++ writes during
    // `__cxa_finalize` — flows to the log file.
    fs.closeSync(2);
    const fd = fs.openSync(logPath, 'a');
    if (fd !== 2) {
      // Couldn't reclaim fd 2 — leave things as they are rather than risk
      // writing the result to the wrong descriptor.
      return;
    }
    fs.writeSync(2, `\n--- shrk native-runtime teardown @ ${new Date().toISOString()} ---\n`);
  } catch {
    // Best-effort containment; never let log redirection break the exit.
  }
}

// Entry point when invoked directly.
//
// Bun exposes `import.meta.main`; Node does not. When Node runs the
// compiled `dist/main.js` directly the path-suffix check (`main.js`)
// catches it. The npm bin shim points at `shrk` so that suffix also
// triggers it. Source dev under Bun still runs via `main.ts`.
const isMain =
  typeof import.meta !== 'undefined' && (import.meta as { main?: boolean }).main === true;
const entryPath = process.argv[1] ?? '';
if (
  isMain ||
  entryPath.endsWith('main.ts') ||
  entryPath.endsWith('main.js') ||
  entryPath.endsWith('shrk') ||
  entryPath.endsWith('shrk.js') ||
  entryPath.endsWith('shrk.cmd')
) {
  // Marks a real CLI invocation (vs. a command handler imported directly by a
  // test). Commands that re-exec themselves in an isolated child gate on this
  // so unit tests calling `run()` in-process never spawn a subprocess.
  process.env.SHRK_CLI = '1';
  loadDotenv(process.cwd());
  const argv = process.argv.slice(2);
  const cleanShutdown = async (code: number): Promise<void> => {
    // Best-effort teardown of shared native runtimes. Without this,
    // commands that loaded native libs (ONNX via embeddings; Metal
    // via node-llama-cpp) abort during `process.exit` AFTER the
    // work completed — the user sees their result then `zsh: abort`.
    // Dynamic imports keep these off the hot path for commands that
    // never touched them.
    // Track whether any native runtime (ONNX via embeddings, Metal/ggml via
    // node-llama-cpp) was actually loaded this run. If so, its static
    // destructors can still abort with a backtrace during `exit()` below —
    // and there is no JS hook in this Node version to skip libc++ finalizers.
    // We contain that by redirecting fd 2 to a log file just before exit.
    let nativeRuntimeLoaded = false;
    try {
      const mod = (await import('@shrkcrft/embeddings')) as {
        disposeSemanticIndexPipeline?: () => Promise<boolean>;
      };
      if (typeof mod.disposeSemanticIndexPipeline === 'function') {
        nativeRuntimeLoaded = (await mod.disposeSemanticIndexPipeline()) || nativeRuntimeLoaded;
      }
    } catch {
      // Best-effort; never block the exit on teardown failure.
    }
    try {
      const mod = (await import('@shrkcrft/ai')) as {
        disposeLlamaCppRuntime?: () => Promise<boolean>;
      };
      if (typeof mod.disposeLlamaCppRuntime === 'function') {
        nativeRuntimeLoaded = (await mod.disposeLlamaCppRuntime()) || nativeRuntimeLoaded;
      }
    } catch {
      // Best-effort.
    }
    // Flush stdio synchronously before bypassing C++ destructors.
    // `_exit` skips all libc finalizers, which is exactly what we
    // need (see below), but it also doesn't wait for buffered
    // writes to drain. Two synchronous write callbacks force the
    // current buffers through.
    try {
      await new Promise<void>((resolve) => process.stdout.write('', () => resolve()));
      await new Promise<void>((resolve) => process.stderr.write('', () => resolve()));
    } catch {
      // ignore flush failures
    }
    // When running as an isolated worker (e.g. the smart-context child), hand
    // the real exit code back to the parent via a sentinel file. The native
    // teardown abort below would otherwise clobber it with SIGABRT (134).
    const exitCodeFile = process.env.SHRK_WORKER_EXITCODE_FILE;
    if (exitCodeFile) {
      try {
        const fs = await import('node:fs');
        fs.writeFileSync(exitCodeFile, String(code), 'utf8');
      } catch {
        // best-effort; parent falls back to the child's signal/code.
      }
    }
    // Contain native-runtime teardown noise. The ggml/ONNX destructors write a
    // backtrace + `libc++abi: terminating … mutex lock failed` straight to fd 2
    // during `exit()`, AFTER our real output is already on screen. That bypasses
    // any JS stream wrapper, so the only reliable way to keep it off the user's
    // terminal is to point fd 2 at a log file first: close(2) frees the lowest
    // fd, and the next open() reclaims it. Gated on `nativeRuntimeLoaded` so
    // ordinary commands keep their stderr untouched.
    if (nativeRuntimeLoaded) {
      await redirectStderrToTeardownLog();
    }
    // Prefer a low-level exit over `process.exit` on Node. Without
    // this, libc++ static destructors run during `process.exit`, and
    // native bindings still resident in memory abort with libc++abi
    // errors AFTER the user's result has already printed:
    //   - node-llama-cpp's libggml-metal hits `GGML_ASSERT([rsets->data
    //     count] == 0)` in `ggml_metal_device_free` → `zsh: abort`.
    //   - onnxruntime-node's worker pool aborts with
    //     `libc++abi: mutex lock failed: Invalid argument` after a
    //     successful `shrk smart-context embeddings-build`. NOTE:
    //     `pipeline.dispose()` returns cleanly, but ONNX worker threads
    //     are not actually joined — they continue running briefly and
    //     hit the pthread mutex teardown race. There is no JS-layer
    //     fix for this; upstream onnxruntime-node 1.21 has the bug.
    //     The low-level exit at least suppresses the destructor pass
    //     so the failure mode is "noisy stderr, exit code preserved"
    //     rather than "destructor cascade".
    //
    // Node exposes the low-level exit under two names depending on the
    // version:
    //   - `process._exit`     — public alias (older Node; removed from
    //                            the public surface on Node 22+).
    //   - `process.reallyExit` — Node-internal name; still present on
    //                            Node 22 even when `_exit` is undefined.
    // Try both in order. Bun's process object doesn't expose either,
    // but Bun also doesn't drive shutdown through libuv + libc++ static
    // destructors the same way Node does, so the crash doesn't
    // reproduce there. Fall back to `process.exit` when no low-level
    // hook is available.
    const proc = process as unknown as {
      _exit?: (code: number) => never;
      reallyExit?: (code: number) => never;
    };
    const lowLevelExit =
      typeof proc._exit === 'function'
        ? proc._exit
        : typeof proc.reallyExit === 'function'
          ? proc.reallyExit
          : null;
    if (lowLevelExit !== null) {
      lowLevelExit(code);
    }
    process.exit(code);
  };
  runCli(argv).then(
    (code) => cleanShutdown(code),
    (err) => {
      process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
      return cleanShutdown(1);
    },
  );
}
