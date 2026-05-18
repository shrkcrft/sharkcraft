/**
 * R29 PART 12 — SharkCraft self agent-tests.
 * R30 PART 2 — Strict expectation fields catch ranker / registry drift.
 * Engine self-config no longer hosts project-specific tests.
 * Project-specific agent tests live in the consumer pack.
 *
 * Each test specifies a task string + the expected rule / template /
 * forbidden actions / verification commands / helpers / playbooks /
 * policies / constructs / commands / knowledge the inspection must
 * surface. Run with `shrk test agent`.
 */
interface ILocalAgentContractTest {
  id: string;
  task: string;
  expectedPipeline?: string;
  expectedTemplates?: readonly string[];
  expectedRules?: readonly string[];
  expectedForbiddenActions?: readonly string[];
  expectedVerificationCommands?: readonly string[];
  /** R30 fields. */
  expectedHelpers?: readonly string[];
  expectedPlaybooks?: readonly string[];
  expectedPolicies?: readonly string[];
  expectedConstructs?: readonly string[];
  expectedCommands?: readonly string[];
  expectedKnowledge?: readonly string[];
  minConfidence?: 'high' | 'medium' | 'low';
  mustNotInclude?: readonly string[];
}

function defineAgentContractTest(t: ILocalAgentContractTest): ILocalAgentContractTest {
  return t;
}

export default [
  defineAgentContractTest({
    id: 'rename-a-plugin',
    task: 'rename a plugin via the active lifecycle profile',
    expectedRules: ['repo.architecture.respect-layer-order'],
    expectedHelpers: ['core.rename-plugin-key', 'core.rename-plugin-folder'],
    expectedKnowledge: ['engine.plugin-lifecycle-profiles'],
    expectedPolicies: ['sharkcraft.no-destructive-without-approval'],
  }),
  defineAgentContractTest({
    id: 'remove-a-plugin',
    task: 'remove an obsolete plugin and clean up its registry entries',
    expectedRules: ['repo.architecture.respect-layer-order'],
    expectedHelpers: ['core.remove-plugin-key', 'core.remove-default-registration'],
    expectedKnowledge: ['engine.plugin-lifecycle-profiles'],
    expectedPolicies: ['sharkcraft.no-destructive-without-approval'],
  }),
  defineAgentContractTest({
    id: 'fix-changed-only-boundary',
    task: 'fix a boundary issue introduced in my changed files only',
    expectedRules: ['repo.architecture.respect-layer-order'],
    expectedKnowledge: ['engine.changed-only-boundaries'],
  }),
  defineAgentContractTest({
    id: 'add-a-helper-plan',
    task: 'add a new helper plan generator for adding a plugin key',
    expectedHelpers: ['core.add-plugin-key'],
    expectedKnowledge: ['engine.helper-plan-registry'],
  }),
  defineAgentContractTest({
    id: 'add-a-new-cli-command',
    task: 'add a new shrk CLI command for templates rollback',
    expectedTemplates: ['engine.cli-command'],
    expectedRules: ['repo.architecture.respect-layer-order'],
  }),
  defineAgentContractTest({
    id: 'add-a-new-mcp-tool',
    task: 'add a new read-only MCP tool that exposes the registry lifecycle report',
    expectedTemplates: ['engine.mcp-tool'],
    expectedRules: ['repo.safety.mcp-is-read-only'],
    expectedPolicies: ['sharkcraft.mcp-read-only'],
  }),
  defineAgentContractTest({
    id: 'add-a-new-inspector-module',
    task: 'add a new inspector module that surfaces release-candidate readiness',
    expectedRules: ['repo.architecture.respect-layer-order'],
  }),
  defineAgentContractTest({
    id: 'add-polyglot-java-support',
    task: 'add Java language detection and command inference',
    expectedKnowledge: ['engine.language-tooling'],
    expectedPolicies: ['sharkcraft.language-runner-allowlist'],
  }),
  defineAgentContractTest({
    id: 'debug-module-not-found-error',
    task: 'debug a ModuleNotFoundError in a Python test runner',
    expectedKnowledge: ['engine.language-tooling'],
  }),
  // ── R31 ────────────────────────────────────────────────────
  defineAgentContractTest({
    id: 'r31.why-did-plugin-rename-not-surface',
    task: 'explain why the plugin rename helper did not rank for my task',
    expectedKnowledge: ['engine.ranker-why'],
  }),
  defineAgentContractTest({
    id: 'r31.find-command-for-feedback-rules',
    task: 'find the shrk command for listing feedback rules',
    expectedKnowledge: ['engine.command-discovery'],
  }),
  defineAgentContractTest({
    id: 'r31.generate-pr-summary',
    task: 'generate a PR summary for the staged changes',
    expectedKnowledge: ['engine.pr-summary', 'engine.changes-summary'],
  }),
  defineAgentContractTest({
    id: 'r31.scaffold-coverage-generic',
    task: 'show scaffold coverage gaps for the current task',
    expectedKnowledge: ['engine.scaffold-coverage'],
  }),
  defineAgentContractTest({
    id: 'r31.watch-knowledge-stale-check',
    task: 'watch knowledge stale check for local development',
    expectedKnowledge: ['engine.watch-loops'],
  }),
  defineAgentContractTest({
    id: 'r31.explain-search-tuning',
    task: 'explain search tuning for plugin renderer',
    expectedKnowledge: ['engine.search-tuning-explain-cli'],
  }),
  // ── R32 ────────────────────────────────────────────────────
  defineAgentContractTest({
    id: 'r32.lifecycle-profiles-discovery',
    task: 'list registered plugin lifecycle profiles',
    expectedKnowledge: ['engine.plugin-lifecycle-profiles'],
  }),
  defineAgentContractTest({
    id: 'r32.project-coupling-audit',
    task: 'audit project-specific coupling in this workspace',
    expectedKnowledge: ['engine.project-coupling-migration'],
  }),
];
